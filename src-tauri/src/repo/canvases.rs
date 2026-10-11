use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{edges, ensure_finite, new_id, nodes};
use crate::error::{AppError, AppResult};
use crate::model::{Canvas, CanvasData, NodeKind, Viewport};

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
    })
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
