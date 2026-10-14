//! Перестройка дерева задач (ТЗ §4.12.3): удаление родителя с переносом
//! подзадач на его уровень или с превращением их слоя в «ничейный», перенос
//! нод в другую задачу («Перенести в задачу…»).
//!
//! Каждая операция возвращает состояние затронутых холстов до и после
//! (`RegionChange`); undo/redo на фронте — `apply_region(before | after)`.
//! Снимок области «плоский»: строки холстов, их ноды и связи; поддеревья
//! перенесённых нод висят на своих владельцах и не меняются.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::{canvases, edges, new_id, nodes};
use crate::error::{AppError, AppResult};
use crate::model::{DeleteMode, NodeKind, RegionChange, RegionSnapshot};

/// Снимок области: холсты `region` (несуществующие — только в списке
/// `region`), их ноды и связи.
pub fn region_snapshot(conn: &Connection, region: &[String]) -> AppResult<RegionSnapshot> {
    let mut snap = RegionSnapshot::default();
    let mut seen = HashSet::new();
    for id in region {
        if !seen.insert(id.clone()) {
            continue;
        }
        snap.region.push(id.clone());
        if let Some(c) = canvases::find(conn, id)? {
            snap.nodes.extend(nodes::list_by_canvas(conn, id)?);
            snap.edges.extend(edges::list_by_canvas(conn, id)?);
            snap.canvases.push(c);
        }
    }
    Ok(snap)
}

fn exists(conn: &Connection, table: &str, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        [id],
        |r| r.get(0),
    )?)
}

/// Приводит холсты области к снимку (одна транзакция, всё или ничего):
/// холсты снимка — существуют с теми же владельцем/хозяином; ноды снимка —
/// на своих холстах (у существующих меняется только холст: заголовки, статусы,
/// ссылки и положение не трогаются); ноды холстов области, которых нет в
/// снимке, удаляются; связи холстов области — ровно как в снимке; холсты
/// области, которых нет в снимке, удаляются.
pub fn apply_region(conn: &Connection, snap: &RegionSnapshot) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    // Холст ссылается на владельца, нода — на холст: проверка внешних ключей —
    // при коммите.
    tx.pragma_update(None, "defer_foreign_keys", "ON")?;

    let region: HashSet<&str> = snap.region.iter().map(String::as_str).collect();
    let keep_canvases: HashSet<&str> = snap.canvases.iter().map(|c| c.id.as_str()).collect();
    let keep_nodes: HashSet<&str> = snap.nodes.iter().map(|n| n.id.as_str()).collect();
    let keep_edges: HashSet<&str> = snap.edges.iter().map(|e| e.id.as_str()).collect();
    let roots: HashSet<String> = {
        let mut stmt = tx.prepare("SELECT root_canvas FROM spaces")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };

    // 1. Холсты.
    for c in &snap.canvases {
        if !region.contains(c.id.as_str()) {
            return Err(AppError::Invalid(format!("холст {} вне области", c.id)));
        }
        if exists(&tx, "canvases", &c.id)? {
            tx.execute(
                "UPDATE canvases SET owner_node = ?2, host_canvas = ?3 WHERE id = ?1",
                params![c.id, c.owner_node, c.host_canvas],
            )?;
        } else {
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
    }

    // 2. Ноды снимка — на свои холсты.
    for n in &snap.nodes {
        if !keep_canvases.contains(n.canvas_id.as_str()) {
            return Err(AppError::Invalid(format!("нода {} вне области", n.id)));
        }
        if exists(&tx, "nodes", &n.id)? {
            tx.execute(
                "UPDATE nodes SET canvas_id = ?2 WHERE id = ?1",
                params![n.id, n.canvas_id],
            )?;
        } else {
            nodes::insert_full(&tx, n)?;
        }
    }

    // 3. Лишние ноды холстов области (каскадом — их поддеревья и связи).
    let mut extra_nodes = Vec::new();
    {
        let mut stmt = tx.prepare("SELECT id FROM nodes WHERE canvas_id = ?1")?;
        for cid in &snap.region {
            let ids: Vec<String> = stmt
                .query_map([cid], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            extra_nodes.extend(
                ids.into_iter()
                    .filter(|id| !keep_nodes.contains(id.as_str())),
            );
        }
    }
    for id in &extra_nodes {
        tx.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
    }

    // 4. Связи холстов области — как в снимке.
    {
        let mut stmt = tx.prepare("SELECT id FROM edges WHERE canvas_id = ?1")?;
        let mut extra = Vec::new();
        for cid in &snap.region {
            let ids: Vec<String> = stmt
                .query_map([cid], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            extra.extend(
                ids.into_iter()
                    .filter(|id| !keep_edges.contains(id.as_str())),
            );
        }
        for id in &extra {
            tx.execute("DELETE FROM edges WHERE id = ?1", [id])?;
        }
    }
    for e in &snap.edges {
        if exists(&tx, "edges", &e.id)? {
            tx.execute(
                "UPDATE edges SET canvas_id = ?2 WHERE id = ?1",
                params![e.id, e.canvas_id],
            )?;
            continue;
        }
        // Конец успел исчезнуть или такая же стрелка уже есть — пропускаем.
        let ok: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE id = ?2)
                AND EXISTS(SELECT 1 FROM nodes WHERE id = ?3)
                AND NOT EXISTS(SELECT 1 FROM edges
                               WHERE canvas_id = ?1 AND source = ?2 AND target = ?3 AND kind = ?4)",
            params![e.canvas_id, e.source, e.target, e.kind.as_str()],
            |r| r.get(0),
        )?;
        if !ok {
            continue;
        }
        edges::insert_full(&tx, e)?;
    }

    // 5. Холсты области, которых нет в снимке.
    for cid in &snap.region {
        if keep_canvases.contains(cid.as_str()) {
            continue;
        }
        if roots.contains(cid) {
            return Err(AppError::Invalid("корневой холст удалить нельзя".into()));
        }
        tx.execute("DELETE FROM canvases WHERE id = ?1", [cid])?;
    }

    tx.commit()?;
    Ok(())
}

fn child_canvas(conn: &Connection, node_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM canvases WHERE owner_node = ?1",
            [node_id],
            |r| r.get(0),
        )
        .optional()?)
}

fn hosted_canvases(conn: &Connection, canvas_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM canvases WHERE host_canvas = ?1 ORDER BY id")?;
    let rows = stmt.query_map([canvas_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Удаляет ноды `ids` (и связи `edge_ids`), решая судьбу подзадач удаляемых
/// задач (ТЗ §4.12.3). Стрелки между задачей и её подзадачами удаляются всегда.
/// - `Lift` — подзадачи (со своими поддеревьями) и стрелки между ними
///   переезжают на холст удаляемой задачи, на свои же координаты;
/// - `Orphan` — слой подзадач остаётся как есть, но становится ничейным
///   (`owner_node = NULL`, `host_canvas` = холст удаляемой задачи); пустой слой
///   просто удаляется вместе с задачей.
pub fn delete_with_mode(
    conn: &Connection,
    ids: &[String],
    edge_ids: &[String],
    mode: DeleteMode,
) -> AppResult<RegionChange> {
    let tx = conn.unchecked_transaction()?;
    let mut region: Vec<String> = Vec::new();
    let mut doomed: Vec<String> = Vec::new();
    for id in ids {
        let Some(n) = nodes::find(&tx, id)? else {
            continue;
        };
        region.push(n.canvas_id.clone());
        if let Some(c) = child_canvas(&tx, id)? {
            region.extend(hosted_canvases(&tx, &c)?);
            region.push(c);
        }
        doomed.push(n.id);
    }
    for id in edge_ids {
        if let Ok(e) = edges::get(&tx, id) {
            region.push(e.canvas_id);
        }
    }
    let before = region_snapshot(&tx, &region)?;

    for id in edge_ids {
        tx.execute("DELETE FROM edges WHERE id = ?1", [id])?;
    }
    for p in &doomed {
        // Холст задачи — на момент обработки (её саму могли поднять раньше).
        let Some(here) = nodes::find(&tx, p)?.map(|n| n.canvas_id) else {
            continue;
        };
        let Some(child) = child_canvas(&tx, p)? else {
            continue;
        };
        tx.execute(
            "DELETE FROM edges WHERE canvas_id = ?1 AND (source = ?2 OR target = ?2)",
            params![child, p],
        )?;
        match mode {
            DeleteMode::Lift => {
                tx.execute(
                    "UPDATE edges SET canvas_id = ?2 WHERE canvas_id = ?1",
                    params![child, here],
                )?;
                tx.execute(
                    "UPDATE nodes SET canvas_id = ?2 WHERE canvas_id = ?1",
                    params![child, here],
                )?;
                tx.execute(
                    "UPDATE canvases SET host_canvas = ?2 WHERE host_canvas = ?1",
                    params![child, here],
                )?;
            }
            DeleteMode::Orphan => {
                let empty: bool = tx.query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM nodes WHERE canvas_id = ?1)
                        AND NOT EXISTS(SELECT 1 FROM canvases WHERE host_canvas = ?1)",
                    [&child],
                    |r| r.get(0),
                )?;
                if !empty {
                    tx.execute(
                        "UPDATE canvases SET owner_node = NULL, host_canvas = ?2 WHERE id = ?1",
                        params![child, here],
                    )?;
                }
            }
        }
    }
    for id in &doomed {
        tx.execute("DELETE FROM nodes WHERE id = ?1", [id])?;
    }
    let mut after = region_snapshot(&tx, &region)?;
    after.region.clone_from(&before.region);
    tx.commit()?;
    Ok(RegionChange { before, after })
}

/// Задачи-владельцы всех холстов выше `canvas_id` (через ничейные слои — к их
/// хозяевам), начиная с ближайшей.
fn ancestor_owners(conn: &Connection, canvas_id: &str) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = canvas_id.to_owned();
    for _ in 0..64 {
        let Some(c) = canvases::find(conn, &cur)? else {
            break;
        };
        match (c.owner_node, c.host_canvas) {
            (Some(o), _) => {
                cur = nodes::get(conn, &o)?.canvas_id;
                out.push(o);
            }
            (None, Some(h)) => cur = h,
            (None, None) => break,
        }
    }
    Ok(out)
}

/// «Перенести в задачу…» (ТЗ §4.12.3): ноды `ids` (с их поддеревьями) переезжают
/// во вложенный холст задачи `target` на свои координаты. Стрелки между
/// перенесёнными нодами едут с ними; стрелки перенесённых нод к самой
/// `target` становятся стрелками «подзадача ↔ родитель» её слоя; остальные
/// стрелки к оставшимся нодам удаляются. Опустевший ничейный слой удаляется.
/// Нельзя переносить задачу в саму себя и в её потомка, а также в другое пространство.
pub fn move_into_task(conn: &Connection, ids: &[String], target: &str) -> AppResult<RegionChange> {
    let tx = conn.unchecked_transaction()?;
    let target_node = nodes::get(&tx, target)?;
    if target_node.kind != NodeKind::Task {
        return Err(AppError::Invalid("переносить можно только в задачу".into()));
    }
    let space = canvases::get(&tx, &target_node.canvas_id)?.space_id;
    let mut moved: Vec<String> = Vec::new();
    let mut sources: Vec<String> = Vec::new();
    for id in ids {
        if moved.contains(id) {
            continue;
        }
        let n = nodes::get(&tx, id)?;
        if n.id == target {
            return Err(AppError::Invalid(
                "нельзя перенести задачу в саму себя".into(),
            ));
        }
        if canvases::get(&tx, &n.canvas_id)?.space_id != space {
            return Err(AppError::Invalid(
                "переносить можно только в задачу того же пространства".into(),
            ));
        }
        if !sources.contains(&n.canvas_id) {
            sources.push(n.canvas_id.clone());
        }
        moved.push(n.id);
    }
    if moved.is_empty() {
        return Err(AppError::Invalid("нечего переносить".into()));
    }
    // Стикеры (ТЗ §4.12.7) едут со своей задачей; отдельно стикер не переносится.
    {
        let mut stmt = tx.prepare("SELECT id FROM nodes WHERE sticker_of = ?1 ORDER BY id")?;
        let mut i = 0;
        while i < moved.len() {
            let found: Vec<String> = stmt
                .query_map([&moved[i]], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for s in found {
                if !moved.contains(&s) {
                    moved.push(s);
                }
            }
            i += 1;
        }
    }
    for id in &moved {
        if let Some(h) = nodes::get(&tx, id)?.sticker_of {
            if !moved.contains(&h) {
                return Err(AppError::Invalid(
                    "стикер переносится только вместе со своей задачей".into(),
                ));
            }
        }
    }
    let owners = ancestor_owners(&tx, &target_node.canvas_id)?;
    if owners.iter().any(|o| moved.contains(o)) {
        return Err(AppError::Invalid(
            "нельзя перенести задачу в её же подзадачу".into(),
        ));
    }

    let existing = child_canvas(&tx, target)?;
    if let Some(t) = &existing {
        if sources.iter().all(|s| s == t) {
            return Err(AppError::Invalid("ноды уже лежат в этой задаче".into()));
        }
    }
    let mut region = sources.clone();
    region.extend(existing.iter().cloned());
    let before = region_snapshot(&tx, &region)?;

    let dest = match existing {
        Some(t) => t,
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO canvases (id, space_id, owner_node) VALUES (?1, ?2, ?3)",
                params![id, space, target],
            )?;
            region.push(id.clone());
            id
        }
    };

    let moved_set: HashSet<&str> = moved.iter().map(String::as_str).collect();
    for s in sources.iter().filter(|s| **s != dest) {
        for e in edges::list_by_canvas(&tx, s)? {
            let src_in = moved_set.contains(e.source.as_str());
            let dst_in = moved_set.contains(e.target.as_str());
            if !src_in && !dst_in {
                continue;
            }
            let keep = (src_in && dst_in)
                || (src_in && e.target == target)
                || (dst_in && e.source == target);
            if keep {
                tx.execute(
                    "UPDATE edges SET canvas_id = ?2 WHERE id = ?1",
                    params![e.id, dest],
                )?;
            } else {
                tx.execute("DELETE FROM edges WHERE id = ?1", [&e.id])?;
            }
        }
    }
    {
        let mut stmt = tx.prepare("UPDATE nodes SET canvas_id = ?2 WHERE id = ?1")?;
        for id in &moved {
            stmt.execute(params![id, dest])?;
        }
    }
    // Опустевший ничейный слой больше не нужен.
    for s in &sources {
        let orphan = canvases::find(&tx, s)?.is_some_and(|c| c.is_orphan());
        if !orphan {
            continue;
        }
        let empty: bool = tx.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM nodes WHERE canvas_id = ?1)
                AND NOT EXISTS(SELECT 1 FROM canvases WHERE host_canvas = ?1)",
            [s],
            |r| r.get(0),
        )?;
        if empty {
            tx.execute("DELETE FROM canvases WHERE id = ?1", [s])?;
        }
    }

    let mut before = before;
    let after = region_snapshot(&tx, &region)?;
    before.region.clone_from(&after.region);
    tx.commit()?;
    Ok(RegionChange { before, after })
}
