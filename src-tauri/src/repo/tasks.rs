//! Обзор задач пространства (ТЗ §4.6.1): плоский список всех задач всех
//! уровней; дерево по родителям строит фронт (`src/overview/tree.ts`).

use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::{parse_col, spaces};
use crate::error::AppResult;
use crate::model::{PanelTask, SpaceTask};

/// Все задачи пространства `space_id` (все уровни вложенности).
///
/// Обход — рекурсивный CTE от корневого холста пространства по
/// `canvases.owner_node`, поэтому в список попадают только холсты, реально
/// достижимые от корня. Порядок: по глубине, затем по положению на холсте
/// (сверху вниз, слева направо), затем по времени создания.
pub fn list_space_tasks(conn: &Connection, space_id: &str) -> AppResult<Vec<SpaceTask>> {
    let space = spaces::get(conn, space_id)?;
    let mut stmt = conn.prepare(
        "WITH RECURSIVE lvl(canvas_id, owner, depth) AS (
             SELECT ?1, NULL, 0
             UNION ALL
             SELECT c.id, c.owner_node, lvl.depth + 1
             FROM lvl
             JOIN nodes o ON o.canvas_id = lvl.canvas_id AND o.kind = 'task'
             JOIN canvases c ON c.owner_node = o.id
             UNION ALL
             -- ничейные слои (ТЗ §4.12.3): родителя нет, уровень — глубже хозяина
             SELECT c.id, NULL, lvl.depth + 1
             FROM lvl
             JOIN canvases c ON c.host_canvas = lvl.canvas_id
         )
         SELECT n.id, n.title, COALESCE(n.status, 'todo'), n.color, n.canvas_id,
                lvl.owner, lvl.depth, n.x, n.y, n.created_at
         FROM lvl JOIN nodes n ON n.canvas_id = lvl.canvas_id
         WHERE n.kind = 'task'
         ORDER BY lvl.depth, n.y, n.x, n.created_at, n.id",
    )?;
    let rows = stmt.query_map([&space.root_canvas], |r| {
        Ok(SpaceTask {
            id: r.get(0)?,
            title: r.get(1)?,
            status: parse_col(2, r.get(2)?)?,
            color: r.get(3)?,
            canvas_id: r.get(4)?,
            parent_node_id: r.get(5)?,
            depth: r.get(6)?,
            x: r.get(7)?,
            y: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Все задачи всех пространств для боковой панели (ТЗ §4.12.5), с путём.
/// Порядок — очередь выполнения: сначала с ручным рангом (`status_rank`), затем
/// остальные по времени создания (новые задачи — в конец); фронт делит по статусам.
pub fn list_all_tasks(conn: &Connection) -> AppResult<Vec<PanelTask>> {
    let mut rank_stmt = conn.prepare(
        "SELECT id FROM nodes WHERE kind = 'task'
         ORDER BY status_rank IS NULL, status_rank, created_at, id",
    )?;
    let order: HashMap<String, usize> = rank_stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();

    let mut out = Vec::new();
    for space in spaces::list(conn)? {
        let list = list_space_tasks(conn, &space.id)?;
        let by_id: HashMap<&str, &SpaceTask> = list.iter().map(|t| (t.id.as_str(), t)).collect();
        // Путь до ничейного слоя (ТЗ §4.12.3) — через его хозяина.
        let mut orphan_paths: HashMap<String, super::canvases::Lineage> = HashMap::new();
        for t in &list {
            let mut parents = Vec::new();
            let mut chain = vec![t.canvas_id.clone()];
            let mut cur = t.parent_node_id.as_deref().and_then(|p| by_id.get(p));
            while let Some(p) = cur {
                parents.push(p.title.clone());
                chain.push(p.canvas_id.clone());
                cur = p.parent_node_id.as_deref().and_then(|q| by_id.get(q));
            }
            let top = chain.last().cloned().unwrap_or_default();
            if top != space.root_canvas {
                if !orphan_paths.contains_key(&top) {
                    let l = super::canvases::lineage(conn, &top)?;
                    orphan_paths.insert(top.clone(), l);
                }
                let l = &orphan_paths[&top];
                parents.extend(l.titles.iter().rev().cloned());
                chain.extend(l.chain.iter().rev().skip(1).cloned());
            }
            parents.reverse();
            chain.reverse();
            out.push(PanelTask {
                id: t.id.clone(),
                title: t.title.clone(),
                status: t.status,
                color: t.color.clone(),
                canvas_id: t.canvas_id.clone(),
                parent_node_id: t.parent_node_id.clone(),
                space_id: space.id.clone(),
                space_name: space.name.clone(),
                parents,
                canvas_chain: chain,
            });
        }
    }
    out.sort_by_key(|t| order.get(&t.id).copied().unwrap_or(usize::MAX));
    Ok(out)
}

/// Ручной порядок: задачи из `ids` получают ранги 1, 2, … в этом порядке
/// (остальные не трогаются). Неизвестный id или заметка — ошибка, пачка откатывается.
pub fn reorder_tasks(conn: &Connection, ids: &[String]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt =
            tx.prepare("UPDATE nodes SET status_rank = ?2 WHERE id = ?1 AND kind = 'task'")?;
        for (i, id) in ids.iter().enumerate() {
            if stmt.execute(params![id, (i + 1) as f64])? == 0 {
                return Err(crate::error::AppError::NotFound(format!("задача {id}")));
            }
        }
    }
    tx.commit()?;
    Ok(())
}
