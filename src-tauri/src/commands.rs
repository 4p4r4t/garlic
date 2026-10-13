//! `#[tauri::command]` — тонкий слой над `repo`. Никакой логики здесь.
//! TS-обёртки: `src/api/index.ts`.

use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::model::{
    Canvas, CanvasData, Edge, NewEdge, NewNode, Node, NodePatch, NodePosition, Space, SubtreeLevel,
    TaskStatus, Viewport,
};
use crate::repo;

/// Единственное соединение с БД, разделяемое командами.
pub struct Db(pub Mutex<Connection>);

impl Db {
    fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| AppError::Other("соединение с БД отравлено".into()))
    }
}

type Cmd<'a> = State<'a, Db>;

// ---- пространства ----

#[tauri::command]
pub async fn list_spaces(db: Cmd<'_>) -> AppResult<Vec<Space>> {
    repo::spaces::list(&*db.conn()?)
}

#[tauri::command]
pub async fn create_space(db: Cmd<'_>, name: String) -> AppResult<Space> {
    repo::spaces::create(&*db.conn()?, &name)
}

#[tauri::command]
pub async fn rename_space(db: Cmd<'_>, id: String, name: String) -> AppResult<Space> {
    repo::spaces::rename(&*db.conn()?, &id, &name)
}

#[tauri::command]
pub async fn delete_space(db: Cmd<'_>, id: String) -> AppResult<()> {
    repo::spaces::delete(&*db.conn()?, &id)
}

// ---- холсты ----

#[tauri::command]
pub async fn load_canvas(db: Cmd<'_>, canvas_id: String) -> AppResult<CanvasData> {
    repo::canvases::load(&*db.conn()?, &canvas_id)
}

#[tauri::command]
pub async fn load_subtree(
    db: Cmd<'_>,
    canvas_id: String,
    max_depth: u32,
) -> AppResult<Vec<SubtreeLevel>> {
    repo::canvases::load_subtree(&*db.conn()?, &canvas_id, max_depth)
}

#[tauri::command]
pub async fn get_or_create_child_canvas(db: Cmd<'_>, node_id: String) -> AppResult<Canvas> {
    repo::canvases::get_or_create_child(&*db.conn()?, &node_id)
}

#[tauri::command]
pub async fn save_viewport(db: Cmd<'_>, canvas_id: String, viewport: Viewport) -> AppResult<()> {
    repo::canvases::save_viewport(&*db.conn()?, &canvas_id, viewport)
}

// ---- ноды ----

/// Нода-заметка сразу получает свой `.md` в базе знаний (ТЗ §4.10).
#[tauri::command]
pub async fn create_node(db: Cmd<'_>, vault: V<'_>, input: NewNode) -> AppResult<Node> {
    let root = vault.root().ok();
    crate::kblink::create_node(&*db.conn()?, root.as_deref(), &input)
}

/// У ноды-заметки новый заголовок переименовывает её `.md` (ТЗ §4.10).
#[tauri::command]
pub async fn update_node(
    db: Cmd<'_>,
    vault: V<'_>,
    id: String,
    patch: NodePatch,
) -> AppResult<Node> {
    let root = vault.root().ok();
    crate::kblink::update_node(&*db.conn()?, root.as_deref(), &id, &patch)
}

#[tauri::command]
pub async fn set_status_many(
    db: Cmd<'_>,
    ids: Vec<String>,
    status: TaskStatus,
) -> AppResult<Vec<Node>> {
    repo::nodes::set_status_many(&*db.conn()?, &ids, status)
}

#[tauri::command]
pub async fn move_nodes(db: Cmd<'_>, positions: Vec<NodePosition>) -> AppResult<()> {
    repo::nodes::move_many(&*db.conn()?, &positions)
}

#[tauri::command]
pub async fn delete_nodes(db: Cmd<'_>, ids: Vec<String>) -> AppResult<usize> {
    repo::nodes::delete_many(&*db.conn()?, &ids)
}

#[tauri::command]
pub async fn count_descendants(db: Cmd<'_>, node_id: String) -> AppResult<i64> {
    repo::nodes::count_descendants(&*db.conn()?, &node_id)
}

// ---- связи ----

#[tauri::command]
pub async fn create_edge(db: Cmd<'_>, input: NewEdge) -> AppResult<Edge> {
    repo::edges::create(&*db.conn()?, &input)
}

#[tauri::command]
pub async fn delete_edges(db: Cmd<'_>, ids: Vec<String>) -> AppResult<usize> {
    repo::edges::delete_many(&*db.conn()?, &ids)
}

// ---- состояние приложения ----

#[tauri::command]
pub async fn get_app_state(db: Cmd<'_>, key: String) -> AppResult<Option<String>> {
    repo::app_state::get(&*db.conn()?, &key)
}

#[tauri::command]
pub async fn set_app_state(db: Cmd<'_>, key: String, value: String) -> AppResult<()> {
    repo::app_state::set(&*db.conn()?, &key, &value)
}

// ---- обзор задач (ТЗ §4.6.1) ----

#[tauri::command]
pub async fn list_space_tasks(
    db: Cmd<'_>,
    space_id: String,
) -> AppResult<Vec<crate::model::SpaceTask>> {
    repo::tasks::list_space_tasks(&*db.conn()?, &space_id)
}

/// Все ноды всех пространств и уровней — для поиска по графу (Ctrl+K).
#[tauri::command]
pub async fn list_graph_nodes(db: Cmd<'_>) -> AppResult<Vec<crate::model::GraphNodeHit>> {
    repo::search::list_graph_nodes(&*db.conn()?)
}

// ---- база знаний (ТЗ §4.10) ----

use crate::vault::{self, ops, Backlink, NoteFile, SearchHit, Vault, VaultEntry, VaultInfo};

type V<'a> = State<'a, Vault>;

/// Обработчик пачки событий watcher'а: переименования снаружи переписывают
/// ссылки нод (`kb_path` и `kb_result_path`), затем пачка уходит во фронт событием `vault:changed`.
pub fn vault_events_handler(app: tauri::AppHandle) -> impl Fn(Vec<vault::VaultEvent>) + Send {
    use tauri::{Emitter, Manager};
    move |events| {
        if let Some(db) = app.try_state::<Db>() {
            if let Ok(conn) = db.conn() {
                for e in &events {
                    if let (vault::VaultEventKind::Rename, Some(from)) = (e.kind, &e.from) {
                        if let Err(err) = repo::kb::rewrite_prefix(&conn, from, &e.path) {
                            eprintln!("[garlic] kb_path rewrite: {err}");
                        }
                    }
                }
            }
        }
        let _ = app.emit(VAULT_EVENT, events);
    }
}

/// Имя Tauri-события с пачкой `VaultEvent`.
pub const VAULT_EVENT: &str = "vault:changed";

#[tauri::command]
pub async fn vault_info(vault: V<'_>) -> AppResult<VaultInfo> {
    Ok(vault.info())
}

/// Сменить папку vault (создаётся при отсутствии), запомнить в app_state,
/// перезапустить слежение. Ссылки нод не трогаются (станут «не найдено»).
#[tauri::command]
pub async fn vault_set_path(
    app: tauri::AppHandle,
    db: Cmd<'_>,
    vault: V<'_>,
    path: String,
) -> AppResult<VaultInfo> {
    let root = std::path::PathBuf::from(path.trim());
    vault.set_root(root.clone(), vault_events_handler(app))?;
    repo::app_state::set(
        &*db.conn()?,
        vault::VAULT_PATH_KEY,
        &root.display().to_string(),
    )?;
    Ok(vault.info())
}

#[tauri::command]
pub async fn vault_tree(vault: V<'_>) -> AppResult<Vec<VaultEntry>> {
    ops::tree(&vault.root()?)
}

#[tauri::command]
pub async fn vault_read(vault: V<'_>, path: String) -> AppResult<NoteFile> {
    ops::read(&vault.root()?, &path)
}

/// Атомарная запись заметки; возвращает новый mtime (мс). `expected_mtime` —
/// mtime, который фронт видел последним: файл изменён снаружи → ошибка
/// `conflict: …` без записи.
#[tauri::command]
pub async fn vault_write(
    vault: V<'_>,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> AppResult<i64> {
    vault.write(&path, &content, expected_mtime)
}

/// Новая заметка в папке `dir` (имя очищается, ` 2`/` 3` при занятом). → путь.
#[tauri::command]
pub async fn vault_create_note(
    vault: V<'_>,
    dir: String,
    name: String,
    content: Option<String>,
) -> AppResult<String> {
    ops::create_note(
        &vault.root()?,
        &dir,
        &name,
        content.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub async fn vault_create_folder(vault: V<'_>, dir: String, name: String) -> AppResult<String> {
    ops::create_folder(&vault.root()?, &dir, &name)
}

/// Переименование на месте (`new_name` у заметки — без `.md`). Ссылки нод
/// (`kb_path`) на сам путь и всё внутри папки переписываются. → новый путь.
#[tauri::command]
pub async fn vault_rename(
    db: Cmd<'_>,
    vault: V<'_>,
    path: String,
    new_name: String,
) -> AppResult<String> {
    let old = vault::paths::normalize_rel(&path)?;
    let new = ops::rename(&vault.root()?, &old, &new_name)?;
    repo::kb::rewrite_prefix(&*db.conn()?, &old, &new)?;
    Ok(new)
}

/// Перемещение в папку `new_dir` (`""` — корень). Ссылки нод переписываются. → новый путь.
#[tauri::command]
pub async fn vault_move(
    db: Cmd<'_>,
    vault: V<'_>,
    path: String,
    new_dir: String,
) -> AppResult<String> {
    let old = vault::paths::normalize_rel(&path)?;
    let new = ops::move_to(&vault.root()?, &old, &new_dir)?;
    repo::kb::rewrite_prefix(&*db.conn()?, &old, &new)?;
    Ok(new)
}

/// Удаление в корзину ОС. Ссылки нод остаются (станут «не найдено»).
#[tauri::command]
pub async fn vault_delete(vault: V<'_>, path: String) -> AppResult<()> {
    ops::delete(&vault.root()?, &path)
}

#[tauri::command]
pub async fn vault_search(
    vault: V<'_>,
    query: String,
    limit: Option<u32>,
) -> AppResult<Vec<SearchHit>> {
    ops::search(&vault.root()?, &query, limit.unwrap_or(200) as usize)
}

#[tauri::command]
pub async fn vault_backlinks(vault: V<'_>, path: String) -> AppResult<Vec<Backlink>> {
    ops::backlinks(&vault.root()?, &path)
}

/// Абсолютный путь (для «Показать в проводнике»).
#[tauri::command]
pub async fn vault_abs_path(vault: V<'_>, path: String) -> AppResult<String> {
    Ok(vault::paths::resolve(&vault.root()?, &path)?
        .display()
        .to_string())
}

/// Ноды всех пространств, привязанные к заметке/папке `path`.
#[tauri::command]
pub async fn kb_linked_nodes(
    db: Cmd<'_>,
    path: String,
) -> AppResult<Vec<crate::model::LinkedNode>> {
    repo::kb::linked_nodes(&*db.conn()?, &vault::paths::normalize_rel(&path)?)
}

/// Все «Результаты» задач (фильтр проводника «Показывать только результаты», ТЗ §4.11).
#[tauri::command]
pub async fn kb_result_links(db: Cmd<'_>) -> AppResult<Vec<crate::model::ResultLink>> {
    repo::kb::result_links(&*db.conn()?)
}

// ---- ссылки нод на базу знаний (ТЗ §4.10, M5.2) ----
// Операции поля-ссылки работают с путём; куда записать результат
// (`update_node(kbPath | kbResultPath)`), решает фронт.

/// Новая заметка/папка для поля-ссылки: в `dir` (не указана — папка по
/// умолчанию для роли `role`: заметка — `kb.default_folder`, комментарий —
/// `kb.default_comment_folder`, результат — `kb.default_result_folder`;
/// создаётся при отсутствии), имя `name`. → путь.
#[tauri::command]
pub async fn kb_create_target(
    db: Cmd<'_>,
    vault: V<'_>,
    kind: crate::kblink::LinkTarget,
    dir: Option<String>,
    name: String,
    role: Option<crate::model::LinkRole>,
) -> AppResult<String> {
    let dir = match dir {
        Some(d) => d,
        None => crate::kblink::default_folder_for(
            &*db.conn()?,
            role.unwrap_or(crate::model::LinkRole::Note),
        )?,
    };
    crate::kblink::create_target(&vault.root()?, &dir, kind, &name)
}

/// «Заметка → папка»: папка `folder_name` рядом с заметкой `path`, заметка
/// переносится в неё (ссылки нод на заметку переписываются). → путь папки.
#[tauri::command]
pub async fn kb_note_to_folder(
    db: Cmd<'_>,
    vault: V<'_>,
    path: String,
    folder_name: String,
) -> AppResult<String> {
    crate::kblink::note_to_folder(&*db.conn()?, &vault.root()?, &path, &folder_name)
}

/// Существование путей ссылок и превью заметок (битые ссылки, карточки заметок).
#[tauri::command]
pub async fn kb_stat(vault: V<'_>, paths: Vec<String>) -> AppResult<Vec<crate::kblink::KbStat>> {
    let root = vault.root().ok();
    Ok(crate::kblink::stat(root.as_deref(), &paths))
}
