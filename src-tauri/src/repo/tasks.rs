//! Обзор задач пространства (ТЗ §4.6.1): плоский список всех задач всех
//! уровней; дерево по родителям строит фронт (`src/overview/tree.ts`).

use rusqlite::Connection;

use super::{parse_col, spaces};
use crate::error::AppResult;
use crate::model::SpaceTask;

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
