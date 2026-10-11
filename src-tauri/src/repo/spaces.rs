use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::model::Space;

pub const DEFAULT_SPACE_NAME: &str = "Основное";

const COLS: &str = "id, name, root_canvas, sort_order, created_at, updated_at";

fn from_row(r: &Row<'_>) -> rusqlite::Result<Space> {
    Ok(Space {
        id: r.get(0)?,
        name: r.get(1)?,
        root_canvas: r.get(2)?,
        sort_order: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid(
            "имя пространства не может быть пустым".into(),
        ));
    }
    Ok(name.to_owned())
}

pub fn list(conn: &Connection) -> AppResult<Vec<Space>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM spaces ORDER BY sort_order, created_at"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn find(conn: &Connection, id: &str) -> AppResult<Option<Space>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM spaces WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Space> {
    find(conn, id)?.ok_or_else(|| AppError::NotFound(format!("пространство {id}")))
}

/// Создаёт пространство вместе с его корневым холстом.
pub fn create(conn: &Connection, name: &str) -> AppResult<Space> {
    let name = clean_name(name)?;
    let tx = conn.unchecked_transaction()?;
    let space_id = new_id();
    let canvas_id = new_id();
    let now = now_ms();
    let sort_order: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM spaces",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO canvases (id, space_id, owner_node) VALUES (?1, ?2, NULL)",
        params![canvas_id, space_id],
    )?;
    tx.execute(
        &format!("INSERT INTO spaces ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?5)"),
        params![space_id, name, canvas_id, sort_order, now],
    )?;
    tx.commit()?;
    get(conn, &space_id)
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> AppResult<Space> {
    let name = clean_name(name)?;
    let n = conn.execute(
        "UPDATE spaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now_ms()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("пространство {id}")));
    }
    get(conn, id)
}

/// Удаляет пространство со всеми его холстами, нодами и связями.
/// Последнее пространство удалить нельзя.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    get(&tx, id)?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM spaces", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(AppError::Invalid(
            "нельзя удалить последнее пространство".into(),
        ));
    }
    // Сначала само пространство (оно ссылается на корневой холст),
    // затем холсты — ноды/связи/вложенные холсты уходят каскадом.
    tx.execute("DELETE FROM spaces WHERE id = ?1", [id])?;
    tx.execute("DELETE FROM canvases WHERE space_id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

/// Гарантирует, что есть хотя бы одно пространство (первый запуск).
pub fn ensure_default(conn: &Connection) -> AppResult<Space> {
    match list(conn)?.into_iter().next() {
        Some(space) => Ok(space),
        None => create(conn, DEFAULT_SPACE_NAME),
    }
}
