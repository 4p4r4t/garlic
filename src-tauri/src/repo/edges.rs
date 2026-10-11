use rusqlite::{params, Connection, Row};

use super::{canvases, new_id, nodes, parse_col};
use crate::error::{AppError, AppResult};
use crate::model::{Edge, HandleSide, NewEdge};

const COLS: &str = "id, canvas_id, source, target, source_handle, target_handle, label";

fn handle_col(r: &Row<'_>, idx: usize) -> rusqlite::Result<Option<HandleSide>> {
    r.get::<_, Option<String>>(idx)?
        .map(|s| parse_col(idx, s))
        .transpose()
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<Edge> {
    Ok(Edge {
        id: r.get(0)?,
        canvas_id: r.get(1)?,
        source: r.get(2)?,
        target: r.get(3)?,
        source_handle: handle_col(r, 4)?,
        target_handle: handle_col(r, 5)?,
        label: r.get(6)?,
    })
}

pub fn list_by_canvas(conn: &Connection, canvas_id: &str) -> AppResult<Vec<Edge>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM edges WHERE canvas_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([canvas_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Edge> {
    conn.query_row(
        &format!("SELECT {COLS} FROM edges WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("связь {id}")),
        e => e.into(),
    })
}

/// Создаёт стрелку. Правила (ТЗ §6):
/// - обе ноды лежат на холсте `canvas_id`, либо `source` — нода-владелец
///   этого холста (якорь слоя: «родитель → подзадача»);
/// - петли и дубли (та же пара source → target) запрещены.
pub fn create(conn: &Connection, input: &NewEdge) -> AppResult<Edge> {
    let canvas = canvases::get(conn, &input.canvas_id)?;
    if input.source == input.target {
        return Err(AppError::Invalid(
            "нельзя соединить ноду саму с собой".into(),
        ));
    }
    let source = nodes::get(conn, &input.source)?;
    let target = nodes::get(conn, &input.target)?;
    if target.canvas_id != canvas.id {
        return Err(AppError::Invalid("целевая нода на другом холсте".into()));
    }
    let source_is_anchor = canvas.owner_node.as_deref() == Some(source.id.as_str());
    if source.canvas_id != canvas.id && !source_is_anchor {
        return Err(AppError::Invalid("исходная нода на другом холсте".into()));
    }
    let dup: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM edges WHERE canvas_id = ?1 AND source = ?2 AND target = ?3)",
        params![canvas.id, source.id, target.id],
        |r| r.get(0),
    )?;
    if dup {
        return Err(AppError::Invalid("такая связь уже есть".into()));
    }
    let id = new_id();
    conn.execute(
        &format!("INSERT INTO edges ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)"),
        params![
            id,
            canvas.id,
            source.id,
            target.id,
            input.source_handle.map(HandleSide::as_str),
            input.target_handle.map(HandleSide::as_str),
        ],
    )?;
    get(conn, &id)
}

/// Удаляет связи. Возвращает число реально удалённых.
pub fn delete_many(conn: &Connection, ids: &[String]) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut deleted = 0;
    {
        let mut stmt = tx.prepare("DELETE FROM edges WHERE id = ?1")?;
        for id in ids {
            deleted += stmt.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(deleted)
}
