use serde::{Serialize, Serializer};

/// Ошибка доменного слоя. Во фронтенд уходит строкой (сообщение).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("ошибка базы данных: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("ошибка файловой системы: {0}")]
    Io(#[from] std::io::Error),
    #[error("не найдено: {0}")]
    NotFound(String),
    #[error("некорректные данные: {0}")]
    Invalid(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
