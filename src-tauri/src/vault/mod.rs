//! База знаний (ТЗ §4.10): папка-vault с обычными `.md`-файлами, совместимая
//! с Obsidian. Здесь — типы, файловые операции (`ops`), пути (`paths`), имена
//! (`names`), ссылки (`links`) и слежение за папкой (`watcher`).
//! Команды Tauri — `commands.rs` (`vault_*`, `kb_*`).

pub mod links;
pub mod names;
pub mod ops;
pub mod paths;
pub mod watcher;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Ключ app_state: абсолютный путь vault.
pub const VAULT_PATH_KEY: &str = "kb.vault_path";
/// Ключ app_state: папка по умолчанию для новых заметок из графа (M5.2).
pub const DEFAULT_FOLDER_KEY: &str = "kb.default_folder";
/// Имя папки vault по умолчанию внутри «Документов».
pub const DEFAULT_VAULT_DIR: &str = "Garlic Vault";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Folder,
    Note,
}

/// Элемент дерева vault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    /// Имя на диске (у заметки — с `.md`).
    pub name: String,
    /// Путь относительно корня, `/`.
    pub path: String,
    pub kind: EntryKind,
    /// Время изменения, мс.
    pub mtime: i64,
    /// Только у папок.
    pub children: Option<Vec<VaultEntry>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub path: String,
    pub content: String,
    pub mtime: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchLine {
    /// Номер строки, с 0.
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    /// Запрос найден в имени файла.
    pub name_match: bool,
    /// Всего строк с совпадением (в `lines` — не больше нескольких первых).
    pub total: u32,
    pub lines: Vec<SearchLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    /// Заметка, в которой есть ссылка.
    pub path: String,
    pub lines: Vec<SearchLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultEventKind {
    Create,
    Modify,
    Remove,
    Rename,
}

/// Событие watcher'а для фронта (Tauri-событие `vault:changed`, пачкой).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    pub kind: VaultEventKind,
    /// Путь (у `rename` — новый).
    pub path: String,
    /// Старый путь у `rename`.
    pub from: Option<String>,
    /// Путь — папка (для удалённого всегда `false`: тип уже не узнать).
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// Абсолютный путь папки vault.
    pub root: String,
    /// Папка доступна (существует).
    pub ok: bool,
    /// Ошибка доступа/слежения, если есть.
    pub error: Option<String>,
}

/// Состояние vault в приложении: корень, слежение, реестр своих записей.
pub struct Vault {
    root: RwLock<PathBuf>,
    pub writes: Arc<watcher::SelfWrites>,
    watcher: Mutex<Option<watcher::VaultWatcher>>,
    error: Mutex<Option<String>>,
}

impl Vault {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: RwLock::new(root),
            writes: Arc::default(),
            watcher: Mutex::new(None),
            error: Mutex::new(None),
        }
    }

    pub fn root(&self) -> AppResult<PathBuf> {
        let root = self
            .root
            .read()
            .map_err(|_| AppError::Other("vault: блокировка отравлена".into()))?
            .clone();
        if !root.is_dir() {
            return Err(AppError::NotFound(format!(
                "папка базы знаний {}",
                root.display()
            )));
        }
        Ok(root)
    }

    pub fn info(&self) -> VaultInfo {
        let root = self.root.read().map(|r| r.clone()).unwrap_or_default();
        VaultInfo {
            root: root.display().to_string(),
            ok: root.is_dir(),
            error: self.error.lock().ok().and_then(|e| e.clone()),
        }
    }

    /// Меняет корень (папка создаётся при отсутствии) и перезапускает слежение.
    pub fn set_root<F>(&self, root: PathBuf, on_events: F) -> AppResult<()>
    where
        F: Fn(Vec<VaultEvent>) + Send + 'static,
    {
        if !root.is_absolute() {
            return Err(AppError::Invalid(format!(
                "путь базы знаний должен быть абсолютным: {}",
                root.display()
            )));
        }
        std::fs::create_dir_all(&root)?;
        if let Ok(mut r) = self.root.write() {
            *r = root;
        }
        self.restart_watcher(on_events);
        Ok(())
    }

    /// (Пере)запускает слежение за текущим корнем. Ошибка запоминается в `info`.
    pub fn restart_watcher<F>(&self, on_events: F)
    where
        F: Fn(Vec<VaultEvent>) + Send + 'static,
    {
        let mut slot = match self.watcher.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        // Старое слежение останавливаем до запуска нового.
        slot.take();
        let result = self
            .root()
            .and_then(|root| watcher::start(root, self.writes.clone(), on_events));
        let err = match result {
            Ok(w) => {
                *slot = Some(w);
                None
            }
            Err(e) => Some(e.to_string()),
        };
        if let Ok(mut e) = self.error.lock() {
            *e = err;
        }
    }

    /// Запись заметки с регистрацией в `SelfWrites` (эхо не уйдёт во фронт).
    pub fn write(&self, rel: &str, content: &str) -> AppResult<i64> {
        let root = self.root()?;
        let (abs, mtime) = ops::write(&root, rel, content)?;
        self.writes.record(abs, mtime);
        Ok(ops::to_ms(mtime))
    }
}

/// Путь vault по умолчанию: `<Документы>/Garlic Vault`.
pub fn default_root(documents: &Path) -> PathBuf {
    documents.join(DEFAULT_VAULT_DIR)
}
