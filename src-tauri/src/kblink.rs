//! Связка нод графа с базой знаний (ТЗ §4.10, M5.2): создание заметки/папки
//! для поля-ссылки, «заметка → папка», нода-заметка как карточка `.md`
//! (файл при создании, заголовок = имя файла), проверка ссылок и превью,
//! миграция старых заметок в `.md`.
//!
//! Операции поля-ссылки не привязаны к колонке `nodes.kb_path`: они работают
//! с путём и возвращают новый путь, а куда его записать, решает вызывающий
//! (сейчас — `update_node(kbPath)`; в M5.3 у задачи будет ещё и «Результат»).
//! Ноды, привязанные к перемещённым путям, переписывает `repo::kb::rewrite_prefix`.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::model::{NewNode, Node, NodeKind, NodePatch};
use crate::repo::{self, kb::note_stem};
use crate::vault::{self, names, ops, paths, preview};

/// Ключ app_state: старые ноды-заметки уже выгружены в `.md` ("1").
pub const NOTES_MIGRATED_KEY: &str = "kb.notes_migrated";
/// Папка vault для выгруженных старых заметок: `Garlic/<пространство>/`.
pub const MIGRATION_DIR: &str = "Garlic";

/// Что создаёт поле-ссылка.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkTarget {
    Note,
    Folder,
}

/// Состояние пути ссылки (`kb_stat`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbStat {
    pub path: String,
    /// Путь существует (папка или `.md`).
    pub exists: bool,
    pub is_dir: bool,
    /// Превью первых строк — только у существующих заметок.
    pub preview: Option<String>,
}

/// Папка для новых заметок/папок из графа (`kb.default_folder`, `""` — корень).
pub fn default_folder(conn: &Connection) -> AppResult<String> {
    match repo::app_state::get(conn, vault::DEFAULT_FOLDER_KEY)? {
        Some(p) => paths::normalize_rel(&p),
        None => Ok(String::new()),
    }
}

/// Папка `dir` внутри vault; создаётся (со всеми предками), если её нет.
pub fn ensure_folder(root: &Path, dir: &str) -> AppResult<String> {
    let dir = paths::normalize_rel(dir)?;
    let abs = paths::resolve(root, &dir)?;
    if abs.is_file() {
        return Err(AppError::Invalid(format!("«{dir}» — файл, а не папка")));
    }
    std::fs::create_dir_all(&abs)?;
    Ok(dir)
}

/// Создаёт заметку или папку для поля-ссылки в `dir` (создаётся при отсутствии).
/// Имя очищается (пустое → «Без названия»), при занятом — ` 2`, ` 3`… → путь.
pub fn create_target(root: &Path, dir: &str, kind: LinkTarget, name: &str) -> AppResult<String> {
    let dir = ensure_folder(root, dir)?;
    match kind {
        LinkTarget::Note => ops::create_note(root, &dir, name, ""),
        LinkTarget::Folder => ops::create_folder(root, &dir, name),
    }
}

/// «Заметка → папка» (ТЗ §4.10): рядом с заметкой `note` создаётся папка
/// `folder_name` (` 2`… при занятом), заметка переносится в неё, ссылки всех
/// нод на заметку переписываются на новый путь. Возвращает путь папки —
/// её записывает в ссылку вызывающий. При ошибке всё откатывается.
pub fn note_to_folder(
    conn: &Connection,
    root: &Path,
    note: &str,
    folder_name: &str,
) -> AppResult<String> {
    let note = paths::normalize_rel(note)?;
    if !paths::is_md(&note) {
        return Err(AppError::Invalid(format!("не заметка (.md): {note}")));
    }
    if !paths::resolve(root, &note)?.is_file() {
        return Err(AppError::NotFound(format!("заметка «{note}»")));
    }
    let dir = paths::parent_rel(&note).to_owned();
    let folder = ops::create_folder(root, &dir, folder_name)?;
    let remove_folder = || {
        if let Ok(abs) = paths::resolve(root, &folder) {
            let _ = std::fs::remove_dir(abs);
        }
    };
    let moved = match ops::move_to(root, &note, &folder) {
        Ok(p) => p,
        Err(e) => {
            remove_folder();
            return Err(e);
        }
    };
    if let Err(e) = repo::kb::rewrite_prefix(conn, &note, &moved) {
        let _ = ops::move_to(root, &moved, &dir);
        remove_folder();
        return Err(e);
    }
    Ok(folder)
}

/// Переименование заметки под новый заголовок ноды: имя очищается, занятое —
/// ` 2`, ` 3`… (смена только регистра — то же имя). → новый путь.
pub fn rename_note_unique(root: &Path, path: &str, title: &str) -> AppResult<String> {
    let path = paths::normalize_rel(path)?;
    let current = note_stem(&path).unwrap_or_default();
    let base = names::sanitize(title);
    if base == current {
        return Ok(path);
    }
    let name = if base.to_lowercase() == current.to_lowercase() {
        base
    } else {
        let dir_abs = paths::resolve(root, paths::parent_rel(&path))?;
        let file = names::unique_name(&dir_abs, &base, ".md");
        file[..file.len() - 3].to_owned()
    };
    ops::rename(root, &path, &name)
}

/// Новая нода. Нода-заметка сразу получает `.md` в папке по умолчанию
/// (имя — заголовок или «Без названия»), заголовок = имя файла. Если база
/// знаний недоступна, заметка создаётся без ссылки (её можно привязать позже).
pub fn create_node(conn: &Connection, root: Option<&Path>, input: &NewNode) -> AppResult<Node> {
    let node = repo::nodes::create(conn, input)?;
    if node.kind != NodeKind::Note {
        return Ok(node);
    }
    let Some(root) = root else {
        return Ok(node);
    };
    let created = default_folder(conn)
        .and_then(|dir| create_target(root, &dir, LinkTarget::Note, &node.title));
    match created {
        Ok(path) => link_note_node(conn, &node.id, &path),
        Err(e) => {
            eprintln!("[garlic] файл новой заметки: {e}");
            Ok(node)
        }
    }
}

/// Ссылка ноды-заметки на `path` и заголовок = имя файла.
fn link_note_node(conn: &Connection, id: &str, path: &str) -> AppResult<Node> {
    repo::nodes::update(
        conn,
        id,
        &NodePatch {
            kb_path: Some(Some(path.to_owned())),
            title: note_stem(path),
            ..NodePatch::default()
        },
    )
}

/// `update_node` с правилами ноды-заметки (ТЗ §4.10):
/// - новый заголовок переименовывает её `.md` (если файл есть), заголовок
///   становится именем файла (очищенным, с ` 2` при занятом), ссылки других
///   нод на файл переписываются;
/// - привязка к другой заметке берёт заголовок из имени файла.
pub fn update_node(
    conn: &Connection,
    root: Option<&Path>,
    id: &str,
    patch: &NodePatch,
) -> AppResult<Node> {
    let node = repo::nodes::get(conn, id)?;
    if node.kind != NodeKind::Note {
        return repo::nodes::update(conn, id, patch);
    }
    let mut patch = patch.clone();
    if let Some(Some(p)) = &patch.kb_path {
        if let Some(stem) = note_stem(&paths::normalize_rel(p)?) {
            patch.title = Some(stem);
        }
    } else if let (Some(title), Some(root), Some(path)) = (&patch.title, root, &node.kb_path) {
        let linked_file = patch.kb_path.is_none()
            && paths::is_md(path)
            && paths::resolve(root, path).is_ok_and(|a| a.is_file());
        if linked_file {
            let new = rename_note_unique(root, path, title)?;
            if new != *path {
                if let Err(e) = repo::kb::rewrite_prefix(conn, path, &new) {
                    let _ = ops::rename(root, &new, &note_stem(path).unwrap_or_default());
                    return Err(e);
                }
            }
            patch.title = note_stem(&new);
        }
    }
    repo::nodes::update(conn, id, &patch)
}

/// Существуют ли пути ссылок (+ превью заметок). Без vault — все «не найдено».
pub fn stat(root: Option<&Path>, list: &[String]) -> Vec<KbStat> {
    list.iter()
        .map(|p| {
            let mut s = KbStat {
                path: p.clone(),
                exists: false,
                is_dir: false,
                preview: None,
            };
            let abs = root.and_then(|r| paths::resolve(r, p).ok());
            if let Some(abs) = abs.filter(|_| !p.trim().is_empty()) {
                if abs.is_dir() {
                    s.exists = true;
                    s.is_dir = true;
                } else if abs.is_file() && paths::is_md(p) {
                    s.exists = true;
                    s.preview = preview::of_file(&abs);
                }
            }
            s
        })
        .collect()
}

/// Миграция v1.3 (ТЗ §4.10): ноды-заметки без ссылки выгружаются в
/// `Garlic/<пространство>/<заголовок>.md` (содержимое — `body`), ссылка
/// и заголовок = имя файла. Один раз (флаг `kb.notes_migrated`); прерванная
/// миграция при повторе продолжает с ещё не выгруженных. → число выгруженных.
pub fn migrate_note_bodies(conn: &Connection, root: &Path) -> AppResult<usize> {
    if repo::app_state::get(conn, NOTES_MIGRATED_KEY)?.as_deref() == Some("1") {
        return Ok(0);
    }
    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.body, s.name
               FROM nodes n
               JOIN canvases c ON c.id = n.canvas_id
               JOIN spaces s ON s.id = c.space_id
              WHERE n.kind = 'note' AND n.kb_path IS NULL
              ORDER BY s.sort_order, s.created_at, n.created_at, n.id",
        )?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        it.collect::<Result<_, _>>()?
    };
    let mut done = 0;
    for (id, title, body, space) in rows {
        let dir = paths::join_rel(MIGRATION_DIR, &names::sanitize(&space));
        let dir = ensure_folder(root, &dir)?;
        let path = ops::create_note(root, &dir, &title, &body)?;
        let stem = note_stem(&path).unwrap_or(title);
        conn.execute(
            "UPDATE nodes SET kb_path = ?2, title = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, path, stem, repo::now_ms()],
        )?;
        done += 1;
    }
    repo::app_state::set(conn, NOTES_MIGRATED_KEY, "1")?;
    Ok(done)
}
