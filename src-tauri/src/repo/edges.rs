use rusqlite::{params, Connection, Row};

use super::{canvases, new_id, nodes, parse_col};
use crate::error::{AppError, AppResult};
use crate::model::{Edge, EdgeKind, HandleSide, NewEdge, NodeKind};

pub(crate) const COLS: &str =
    "id, canvas_id, source, target, source_handle, target_handle, label, kind";

fn handle_col(r: &Row<'_>, idx: usize) -> rusqlite::Result<Option<HandleSide>> {
    r.get::<_, Option<String>>(idx)?
        .map(|s| parse_col(idx, s))
        .transpose()
}

pub(crate) fn from_row(r: &Row<'_>) -> rusqlite::Result<Edge> {
    Ok(Edge {
        id: r.get(0)?,
        canvas_id: r.get(1)?,
        source: r.get(2)?,
        target: r.get(3)?,
        source_handle: handle_col(r, 4)?,
        target_handle: handle_col(r, 5)?,
        label: r.get(6)?,
        kind: parse_col(7, r.get(7)?)?,
    })
}

/// Вставка связи «как было» (undo, перестройки).
pub(crate) fn insert_full(conn: &Connection, e: &Edge) -> AppResult<()> {
    conn.execute(
        &format!("INSERT INTO edges ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
        params![
            e.id,
            e.canvas_id,
            e.source,
            e.target,
            e.source_handle.map(HandleSide::as_str),
            e.target_handle.map(HandleSide::as_str),
            e.label,
            e.kind.as_str()
        ],
    )?;
    Ok(())
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
/// - обе ноды лежат на холсте `canvas_id`, либо одна из них — нода-владелец
///   этого холста (якорь слоя), а другая лежит на нём: «родитель → подзадача»
///   или «подзадача → родитель» (направление — как провели, ТЗ §4.5);
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
    let is_anchor = |id: &str| canvas.owner_node.as_deref() == Some(id);
    let source_ok = source.canvas_id == canvas.id || is_anchor(&source.id);
    let target_ok = target.canvas_id == canvas.id || is_anchor(&target.id);
    if !source_ok {
        return Err(AppError::Invalid("исходная нода на другом холсте".into()));
    }
    if !target_ok {
        return Err(AppError::Invalid("целевая нода на другом холсте".into()));
    }
    if input.kind == EdgeKind::Blocks {
        // «Блокирует» (ТЗ §4.12.7): задача → задача одного холста.
        if source.kind != NodeKind::Task || target.kind != NodeKind::Task {
            return Err(AppError::Invalid(
                "«блокирует» — только между задачами".into(),
            ));
        }
        if source.canvas_id != canvas.id || target.canvas_id != canvas.id {
            return Err(AppError::Invalid(
                "«блокирует» — только между задачами одного холста".into(),
            ));
        }
    }
    if exists_pair(conn, &canvas.id, &source.id, &target.id, input.kind)? {
        return Err(AppError::Invalid("такая связь уже есть".into()));
    }
    let edge = Edge {
        id: input.id.clone().unwrap_or_else(new_id),
        canvas_id: canvas.id,
        source: source.id,
        target: target.id,
        source_handle: input.source_handle,
        target_handle: input.target_handle,
        label: None,
        kind: input.kind,
    };
    insert_full(conn, &edge)?;
    get(conn, &edge.id)
}

/// Есть ли на холсте стрелка того же вида source → target.
pub(crate) fn exists_pair(
    conn: &Connection,
    canvas_id: &str,
    source: &str,
    target: &str,
    kind: EdgeKind,
) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM edges
                       WHERE canvas_id = ?1 AND source = ?2 AND target = ?3 AND kind = ?4)",
        params![canvas_id, source, target, kind.as_str()],
        |r| r.get(0),
    )?)
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
