//! Снимок и восстановление части графа — основа undo/redo удаления и
//! создания нод/связей (ТЗ M6a). История живёт на фронте (в памяти);
//! здесь — только «сфотографировать перед удалением» и «вернуть как было».

use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::{canvases, edges, nodes};
use crate::error::{AppError, AppResult};
use crate::model::GraphSnapshot;

/// Снимок нод `node_ids` (неизвестные id пропускаются) со всеми их вложенными
/// холстами на всех уровнях, нодами и связями этих холстов, связями, где хотя
/// бы один конец — нода снимка (в т.ч. на холсте уровнем выше и стрелки
/// «родитель ↔ подзадача» в слое), и связями `edge_ids`.
pub fn snapshot(
    conn: &Connection,
    node_ids: &[String],
    edge_ids: &[String],
) -> AppResult<GraphSnapshot> {
    let mut snap = GraphSnapshot::default();
    let mut node_set: HashSet<String> = HashSet::new();
    for id in node_ids {
        if node_set.contains(id) {
            continue;
        }
        if let Some(n) = nodes::find(conn, id)? {
            node_set.insert(n.id.clone());
            snap.nodes.push(n);
        }
    }

    // Вложенные холсты — по уровням (BFS), чтобы порядок был по глубине.
    let mut frontier: Vec<String> = snap.nodes.iter().map(|n| n.id.clone()).collect();
    let mut canvas_set: HashSet<String> = HashSet::new();
    let mut owned = conn.prepare(&format!(
        "SELECT {} FROM canvases WHERE owner_node = ?1",
        canvases::COLS
    ))?;
    // Ничейные слои (ТЗ §4.12.3), приютившиеся на холстах снимка, уходят
    // вместе с хозяином каскадом — значит, и в снимок.
    let mut hosted = conn.prepare(&format!(
        "SELECT {} FROM canvases WHERE host_canvas = ?1 ORDER BY id",
        canvases::COLS
    ))?;
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for owner in &frontier {
            let mut found: Vec<_> = owned
                .query_map([owner], canvases::from_row)?
                .collect::<Result<_, _>>()?;
            let mut i = 0;
            while i < found.len() {
                let more: Vec<_> = hosted
                    .query_map([&found[i].id], canvases::from_row)?
                    .collect::<Result<_, _>>()?;
                found.extend(more);
                i += 1;
            }
            for c in found {
                if !canvas_set.insert(c.id.clone()) {
                    continue;
                }
                for n in nodes::list_by_canvas(conn, &c.id)? {
                    if node_set.insert(n.id.clone()) {
                        next.push(n.id.clone());
                        snap.nodes.push(n);
                    }
                }
                snap.canvases.push(c);
            }
        }
        frontier = next;
    }

    // Стикеры (ТЗ §4.12.7) уходят вместе со своей задачей (каскад) — значит, и в снимок.
    {
        let mut stickers = conn.prepare(&format!(
            "SELECT {} FROM nodes WHERE sticker_of = ?1 ORDER BY created_at, id",
            nodes::COLS
        ))?;
        let mut i = 0;
        while i < snap.nodes.len() {
            let id = snap.nodes[i].id.clone();
            let found: Vec<_> = stickers
                .query_map([&id], nodes::from_row)?
                .collect::<Result<_, _>>()?;
            for n in found {
                if node_set.insert(n.id.clone()) {
                    snap.nodes.push(n);
                }
            }
            i += 1;
        }
    }

    let mut edge_set: HashSet<String> = HashSet::new();
    for c in &snap.canvases {
        for e in edges::list_by_canvas(conn, &c.id)? {
            if edge_set.insert(e.id.clone()) {
                snap.edges.push(e);
            }
        }
    }
    let mut touching = conn.prepare(&format!(
        "SELECT {} FROM edges WHERE source = ?1 OR target = ?1 ORDER BY id",
        edges::COLS
    ))?;
    for n in &snap.nodes {
        let found: Vec<_> = touching
            .query_map([&n.id], edges::from_row)?
            .collect::<Result<_, _>>()?;
        for e in found {
            if edge_set.insert(e.id.clone()) {
                snap.edges.push(e);
            }
        }
    }
    for id in edge_ids {
        if edge_set.contains(id) {
            continue;
        }
        if let Ok(e) = edges::get(conn, id) {
            edge_set.insert(e.id.clone());
            snap.edges.push(e);
        }
    }
    Ok(snap)
}

/// Возвращает снимок в БД с теми же id (одна транзакция, всё или ничего).
/// Холст каждой ноды должен существовать (или быть в снимке), а сами id —
/// быть свободны. Связь, у которой конец успел исчезнуть (или такая же
/// стрелка уже проведена заново), пропускается.
/// Возвращает число восстановленных нод.
pub fn restore(conn: &Connection, snap: &GraphSnapshot) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    // Холсты ссылаются на ноды-владельцы, ноды — на холсты: проверка внешних
    // ключей откладывается до коммита (прагма сбрасывается сама).
    tx.pragma_update(None, "defer_foreign_keys", "ON")?;

    let snap_canvases: HashSet<&str> = snap.canvases.iter().map(|c| c.id.as_str()).collect();
    let snap_nodes: HashSet<&str> = snap.nodes.iter().map(|n| n.id.as_str()).collect();

    for n in &snap.nodes {
        if nodes::find(&tx, &n.id)?.is_some() {
            return Err(AppError::Invalid(format!("нода {} уже существует", n.id)));
        }
        if !snap_canvases.contains(n.canvas_id.as_str())
            && canvases::find(&tx, &n.canvas_id)?.is_none()
        {
            return Err(AppError::NotFound(format!(
                "холст {} (его нода-владелец удалена)",
                n.canvas_id
            )));
        }
    }
    for c in &snap.canvases {
        let owner_ok = match (&c.owner_node, &c.host_canvas) {
            (Some(o), _) => snap_nodes.contains(o.as_str()) || nodes::find(&tx, o)?.is_some(),
            // ничейный слой: нужен его холст-хозяин
            (None, Some(h)) => {
                snap_canvases.contains(h.as_str()) || canvases::find(&tx, h)?.is_some()
            }
            (None, None) => false,
        };
        if !owner_ok {
            return Err(AppError::Invalid(format!(
                "у вложенного холста {} нет ноды-владельца",
                c.id
            )));
        }
        tx.execute(
            "INSERT INTO canvases (id, space_id, owner_node, viewport_x, viewport_y, zoom, host_canvas)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                c.id,
                c.space_id,
                c.owner_node,
                c.viewport.x,
                c.viewport.y,
                c.viewport.zoom,
                c.host_canvas
            ],
        )?;
    }
    for n in &snap.nodes {
        nodes::insert_full(&tx, n)?;
    }
    for e in &snap.edges {
        let ok: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM canvases WHERE id = ?1)
                AND EXISTS(SELECT 1 FROM nodes WHERE id = ?2)
                AND EXISTS(SELECT 1 FROM nodes WHERE id = ?3)
                AND NOT EXISTS(SELECT 1 FROM edges WHERE id = ?4
                               OR (canvas_id = ?1 AND source = ?2 AND target = ?3 AND kind = ?5))",
            params![e.canvas_id, e.source, e.target, e.id, e.kind.as_str()],
            |r| r.get(0),
        )?;
        if !ok {
            continue;
        }
        edges::insert_full(&tx, e)?;
    }
    tx.commit()?;
    Ok(snap.nodes.len())
}
