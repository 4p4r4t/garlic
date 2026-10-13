//! Поиск по графу (ТЗ §9 M6b): плоский список всех нод (задач и заметок) всех
//! пространств и уровней с путём; нечёткое совпадение по названию — на фронте.

use std::collections::HashMap;

use rusqlite::Connection;

use super::parse_col;
use crate::error::AppResult;
use crate::model::{GraphNodeHit, NodeKind, TaskStatus};

type RawNode = (String, NodeKind, String, Option<TaskStatus>, String);
type CanvasRow = (Option<String>, String, String, Option<String>);

/// Все ноды-задачи и ноды-заметки всех пространств. Порядок: пространство,
/// положение на холсте. Путь (`parents`) — заголовки задач-владельцев
/// от корня пространства; `canvas_chain` — аргумент `revealNode`.
pub fn list_graph_nodes(conn: &Connection) -> AppResult<Vec<GraphNodeHit>> {
    // canvas id -> (owner node, space id, space name, хозяин ничейного слоя)
    let mut canvases: HashMap<String, CanvasRow> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.owner_node, c.space_id, s.name, c.host_canvas
               FROM canvases c JOIN spaces s ON s.id = c.space_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?),
            ))
        })?;
        for row in rows {
            let (id, v) = row?;
            canvases.insert(id, v);
        }
    }
    // node id -> (title, canvas id) — только задачи (владельцы холстов)
    let mut owners: HashMap<String, (String, String)> = HashMap::new();
    let mut all: Vec<RawNode> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT n.id, n.kind, n.title, n.status, n.canvas_id
               FROM nodes n
               JOIN canvases c ON c.id = n.canvas_id
               JOIN spaces s ON s.id = c.space_id
              ORDER BY s.sort_order, s.created_at, n.y, n.x, n.created_at, n.id",
        )?;
        let rows = stmt.query_map([], |r| {
            let kind: NodeKind = parse_col(1, r.get(1)?)?;
            let status = r
                .get::<_, Option<String>>(3)?
                .map(|s| parse_col(3, s))
                .transpose()?;
            Ok((r.get(0)?, kind, r.get(2)?, status, r.get(4)?))
        })?;
        for row in rows {
            let (id, kind, title, status, canvas_id): RawNode = row?;
            if kind == NodeKind::Task {
                owners.insert(id.clone(), (title.clone(), canvas_id.clone()));
            }
            all.push((id, kind, title, status, canvas_id));
        }
    }

    // canvas id -> (цепочка холстов, заголовки владельцев)
    let mut memo: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
    let mut out = Vec::with_capacity(all.len());
    for (id, kind, title, status, canvas_id) in all {
        let Some((_, space_id, space_name, _)) = canvases.get(&canvas_id) else {
            continue;
        };
        let (chain, parents) = memo
            .entry(canvas_id.clone())
            .or_insert_with(|| {
                let mut chain = vec![canvas_id.clone()];
                let mut parents = Vec::new();
                let mut cur = canvas_id.clone();
                // защита от циклов: глубина ограничена
                for _ in 0..64 {
                    let Some(c) = canvases.get(&cur) else {
                        break;
                    };
                    let parent_canvas = match (&c.0, &c.3) {
                        (Some(owner), _) => {
                            let Some((t, parent_canvas)) = owners.get(owner) else {
                                break;
                            };
                            parents.push(t.clone());
                            parent_canvas.clone()
                        }
                        // Ничейный слой (ТЗ §4.12.3): путь идёт через хозяина.
                        (None, Some(host)) => {
                            parents.push(super::canvases::ORPHAN_LABEL.to_owned());
                            host.clone()
                        }
                        (None, None) => break,
                    };
                    chain.push(parent_canvas.clone());
                    cur = parent_canvas;
                }
                chain.reverse();
                parents.reverse();
                (chain, parents)
            })
            .clone();
        out.push(GraphNodeHit {
            id,
            title,
            kind,
            status,
            space_id: space_id.clone(),
            space_name: space_name.clone(),
            canvas_id,
            canvas_chain: chain,
            parents,
        });
    }
    Ok(out)
}
