//! Ссылки нод на базу знаний (`nodes.kb_path`, ТЗ §4.10).

use rusqlite::{params, Connection};

use super::parse_col;
use crate::error::AppResult;
use crate::model::LinkedNode;

/// Переписывает ссылки после переименования/перемещения в vault: `old` → `new`.
///
/// Меняются ссылки, равные `old`, и все ссылки внутри папки `old/…` (переименование
/// папки тянет за собой пути вложенных заметок и папок). Возвращает число
/// изменённых нод. Идемпотентна: повторный вызов (эхо watcher'а после нашего же
/// переименования) ничего не находит.
pub fn rewrite_prefix(conn: &Connection, old: &str, new: &str) -> AppResult<usize> {
    if old.is_empty() || old == new {
        return Ok(0);
    }
    let old_dir = format!("{old}/");
    // Без LIKE: в именах файлов бывают `%` и `_`.
    Ok(conn.execute(
        "UPDATE nodes
            SET kb_path = ?2 || substr(kb_path, length(?1) + 1)
          WHERE kb_path = ?1
             OR substr(kb_path, 1, length(?3)) = ?3",
        params![old, new, old_dir],
    )?)
}

/// Ноды всех пространств, привязанные ровно к `path` (заметке или папке).
pub fn linked_nodes(conn: &Connection, path: &str) -> AppResult<Vec<LinkedNode>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, n.kind, n.status, n.canvas_id, c.space_id, s.name
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           JOIN spaces s ON s.id = c.space_id
          WHERE n.kb_path = ?1
          ORDER BY s.sort_order, s.created_at, n.created_at",
    )?;
    let rows = stmt
        .query_map([path], |r| {
            Ok((
                LinkedNode {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    kind: parse_col(2, r.get(2)?)?,
                    status: r
                        .get::<_, Option<String>>(3)?
                        .map(|s| parse_col(3, s))
                        .transpose()?,
                    space_id: r.get(5)?,
                    space_name: r.get(6)?,
                    canvas_chain: Vec::new(),
                },
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(rows.len());
    for (mut node, canvas_id) in rows {
        node.canvas_chain = canvas_chain(conn, &canvas_id)?;
        out.push(node);
    }
    Ok(out)
}

/// Цепочка холстов от корневого холста пространства до `canvas_id` включительно.
pub fn canvas_chain(conn: &Connection, canvas_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE up(id, owner, depth) AS (
             SELECT id, owner_node, 0 FROM canvases WHERE id = ?1
             UNION ALL
             SELECT c.id, c.owner_node, up.depth + 1
               FROM up
               JOIN nodes n ON n.id = up.owner
               JOIN canvases c ON c.id = n.canvas_id
              WHERE up.depth < 64
         )
         SELECT id FROM up ORDER BY depth DESC",
    )?;
    let chain = stmt
        .query_map(params![canvas_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(chain)
}
