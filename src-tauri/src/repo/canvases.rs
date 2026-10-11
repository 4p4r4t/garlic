use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{edges, ensure_finite, new_id, nodes};
use crate::error::{AppError, AppResult};
use crate::model::{Canvas, CanvasData, NodeKind, NodeProgress, SubtreeLevel, Viewport};

/// Предел глубины `load_subtree` (защита от слишком тяжёлых запросов).
pub const MAX_SUBTREE_DEPTH: u32 = 16;

const COLS: &str = "id, space_id, owner_node, viewport_x, viewport_y, zoom";

fn from_row(r: &Row<'_>) -> rusqlite::Result<Canvas> {
    Ok(Canvas {
        id: r.get(0)?,
        space_id: r.get(1)?,
        owner_node: r.get(2)?,
        viewport: Viewport {
            x: r.get(3)?,
            y: r.get(4)?,
            zoom: r.get(5)?,
        },
    })
}

pub fn find(conn: &Connection, id: &str) -> AppResult<Option<Canvas>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM canvases WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Canvas> {
    find(conn, id)?.ok_or_else(|| AppError::NotFound(format!("холст {id}")))
}

/// Холст целиком: метаданные, ноды и связи.
pub fn load(conn: &Connection, id: &str) -> AppResult<CanvasData> {
    Ok(CanvasData {
        canvas: get(conn, id)?,
        nodes: nodes::list_by_canvas(conn, id)?,
        edges: edges::list_by_canvas(conn, id)?,
        progress: progress(conn, id)?,
    })
}

/// Прогресс подзадач нод холста `id`: для каждой задачи с вложенным холстом,
/// где есть задачи, — сколько из них `done`. Считается только прямой вложенный
/// холст (подзадачи подзадач не входят — у них свой бейдж).
pub fn progress(conn: &Connection, id: &str) -> AppResult<Vec<NodeProgress>> {
    let mut stmt = conn.prepare(
        "SELECT o.id,
                SUM(CASE WHEN n.status = 'done' THEN 1 ELSE 0 END),
                COUNT(n.id)
         FROM nodes o
         JOIN canvases c ON c.owner_node = o.id
         JOIN nodes n ON n.canvas_id = c.id AND n.kind = 'task'
         WHERE o.canvas_id = ?1
         GROUP BY o.id
         ORDER BY o.id",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(NodeProgress {
            node_id: r.get(0)?,
            done: r.get(1)?,
            total: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Все вложенные холсты под холстом `id` до глубины `max_depth` включительно
/// (рекурсивный CTE), по возрастанию глубины. Нужен для «просвечивания»
/// подзадач на текущем холсте (ТЗ §4.5.1). Сам холст `id` не входит.
pub fn load_subtree(conn: &Connection, id: &str, max_depth: u32) -> AppResult<Vec<SubtreeLevel>> {
    get(conn, id)?;
    let max_depth = max_depth.min(MAX_SUBTREE_DEPTH);
    if max_depth == 0 {
        return Ok(Vec::new());
    }
    struct Row {
        canvas: Canvas,
        parent_canvas: String,
        owner_title: String,
        depth: u32,
    }
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE sub(id, parent_canvas, owner_title, depth) AS (
                 SELECT c.id, o.canvas_id, o.title, 1
                 FROM canvases c JOIN nodes o ON o.id = c.owner_node
                 WHERE o.canvas_id = ?1
                 UNION ALL
                 SELECT c.id, o.canvas_id, o.title, sub.depth + 1
                 FROM sub
                 JOIN nodes o ON o.canvas_id = sub.id
                 JOIN canvases c ON c.owner_node = o.id
                 WHERE sub.depth < ?2
             )
             SELECT c.id, c.space_id, c.owner_node, c.viewport_x, c.viewport_y, c.zoom,
                    sub.parent_canvas, sub.owner_title, sub.depth
             FROM sub JOIN canvases c ON c.id = sub.id
             ORDER BY sub.depth, c.owner_node",
        )?;
        let it = stmt.query_map(params![id, max_depth], |r| {
            Ok(Row {
                canvas: from_row(r)?,
                parent_canvas: r.get(6)?,
                owner_title: r.get(7)?,
                depth: r.get(8)?,
            })
        })?;
        it.collect::<Result<_, _>>()?
    };

    // Строки отсортированы по глубине: путь родителя всегда посчитан раньше.
    let mut paths: HashMap<String, Vec<String>> = HashMap::new();
    paths.insert(id.to_owned(), Vec::new());
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut path = paths.get(&row.parent_canvas).cloned().unwrap_or_default();
        path.push(row.owner_title);
        paths.insert(row.canvas.id.clone(), path.clone());
        let cid = row.canvas.id.clone();
        out.push(SubtreeLevel {
            nodes: nodes::list_by_canvas(conn, &cid)?,
            edges: edges::list_by_canvas(conn, &cid)?,
            progress: progress(conn, &cid)?,
            canvas: row.canvas,
            depth: row.depth,
            path,
        });
    }
    Ok(out)
}

pub fn save_viewport(conn: &Connection, id: &str, vp: Viewport) -> AppResult<()> {
    ensure_finite("viewport.x", vp.x)?;
    ensure_finite("viewport.y", vp.y)?;
    ensure_finite("viewport.zoom", vp.zoom)?;
    if vp.zoom <= 0.0 {
        return Err(AppError::Invalid("zoom должен быть > 0".into()));
    }
    let n = conn.execute(
        "UPDATE canvases SET viewport_x = ?2, viewport_y = ?3, zoom = ?4 WHERE id = ?1",
        params![id, vp.x, vp.y, vp.zoom],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("холст {id}")));
    }
    Ok(())
}

/// Вложенный холст задачи (слой подзадач). Создаётся при первом обращении.
pub fn get_or_create_child(conn: &Connection, node_id: &str) -> AppResult<Canvas> {
    let tx = conn.unchecked_transaction()?;
    let node = nodes::get(&tx, node_id)?;
    if node.kind != NodeKind::Task {
        return Err(AppError::Invalid("подзадачи есть только у задач".into()));
    }
    let existing = tx
        .query_row(
            &format!("SELECT {COLS} FROM canvases WHERE owner_node = ?1"),
            [node_id],
            from_row,
        )
        .optional()?;
    let canvas = match existing {
        Some(c) => c,
        None => {
            let parent = get(&tx, &node.canvas_id)?;
            let id = new_id();
            tx.execute(
                "INSERT INTO canvases (id, space_id, owner_node) VALUES (?1, ?2, ?3)",
                params![id, parent.space_id, node_id],
            )?;
            get(&tx, &id)?
        }
    };
    tx.commit()?;
    Ok(canvas)
}
