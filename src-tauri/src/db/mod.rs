//! Подключение к SQLite и миграции.

mod migrations;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;

pub use migrations::MIGRATIONS;

/// Открывает (или создаёт) файл БД, настраивает прагмы и применяет миграции.
pub fn open(path: &Path) -> AppResult<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// In-memory БД с полной схемой — для тестов.
pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

/// Текущая версия схемы (`PRAGMA user_version`).
pub fn schema_version(conn: &Connection) -> AppResult<u32> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

/// Применяет все ещё не применённые миграции, каждую в своей транзакции.
pub fn migrate(conn: &mut Connection) -> AppResult<()> {
    let current = schema_version(conn)? as usize;
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (idx + 1) as u32)?;
        tx.commit()?;
    }
    Ok(())
}
