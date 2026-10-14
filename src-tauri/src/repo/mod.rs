//! CRUD по сущностям. Вся валидация и бизнес-правила — здесь.
//! Функции принимают `&Connection`; многошаговые операции идут в транзакции.

pub mod app_state;
pub mod blocks;
pub mod canvases;
pub mod edges;
pub mod history;
pub mod kb;
pub mod nodes;
pub mod restructure;
pub mod search;
pub mod spaces;
pub mod tasks;

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};

/// Новый идентификатор (uuid v7 — сортируется по времени создания).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Текущее время, мс с эпохи Unix.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Разбор текстового enum-значения из колонки SQLite.
fn parse_col<T: std::str::FromStr<Err = AppError>>(idx: usize, s: String) -> rusqlite::Result<T> {
    s.parse().map_err(|e: AppError| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn ensure_finite(what: &str, v: f64) -> AppResult<()> {
    if v.is_finite() {
        Ok(())
    } else {
        Err(AppError::Invalid(format!(
            "{what}: ожидалось конечное число"
        )))
    }
}
