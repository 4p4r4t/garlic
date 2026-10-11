//! `#[tauri::command]` — тонкий слой над `repo`. Никакой логики здесь.
//! TS-обёртки: `src/api/index.ts`.

use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::model::{
    Canvas, CanvasData, Edge, NewEdge, NewNode, Node, NodePatch, NodePosition, Space, SubtreeLevel,
    Viewport,
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

#[tauri::command]
pub async fn create_node(db: Cmd<'_>, input: NewNode) -> AppResult<Node> {
    repo::nodes::create(&*db.conn()?, &input)
}

#[tauri::command]
pub async fn update_node(db: Cmd<'_>, id: String, patch: NodePatch) -> AppResult<Node> {
    repo::nodes::update(&*db.conn()?, &id, &patch)
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
