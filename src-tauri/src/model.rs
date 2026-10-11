//! Доменные типы, общие для repo, команд Tauri и фронтенда (serde, camelCase).
//! TS-зеркало: `src/api/types.ts` — держать синхронным.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Task,
    Note,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Done,
}

/// Роль ссылки ноды на базу знаний (ТЗ §4.11): у ноды-заметки — её `.md`
/// (`note`), у задачи — «Комментарий» (`comment`, колонка `kb_path`) или
/// «Результат» (`result`, колонка `kb_result_path`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkRole {
    Note,
    Comment,
    Result,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandleSide {
    Top,
    Right,
    Bottom,
    Left,
}

macro_rules! str_enum {
    ($ty:ty { $($variant:ident => $s:literal),+ $(,)? }) => {
        impl $ty {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
        }
        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
        impl FromStr for $ty {
            type Err = AppError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok(Self::$variant),)+
                    other => Err(AppError::Invalid(format!(
                        concat!("неизвестное значение ", stringify!($ty), ": {}"), other
                    ))),
                }
            }
        }
    };
}

str_enum!(NodeKind { Task => "task", Note => "note" });
str_enum!(TaskStatus { Todo => "todo", InProgress => "in_progress", Done => "done" });
str_enum!(LinkRole { Note => "note", Comment => "comment", Result => "result" });
str_enum!(HandleSide { Top => "top", Right => "right", Bottom => "bottom", Left => "left" });

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    pub root_canvas: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub id: String,
    pub space_id: String,
    /// `None` для корневого холста пространства.
    pub owner_node: Option<String>,
    pub viewport: Viewport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub canvas_id: String,
    pub kind: NodeKind,
    pub title: String,
    pub body: String,
    /// Только для `task`, у заметок всегда `None`.
    pub status: Option<TaskStatus>,
    pub color: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// Ссылка на заметку/папку базы знаний (путь относительно vault, `/`), ТЗ §4.10.
    /// У задачи — «Комментарий» (ТЗ §4.11), у заметки — её собственный `.md`.
    pub kb_path: Option<String>,
    /// «Результат» задачи (ТЗ §4.11); у заметок всегда `None`.
    pub kb_result_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub canvas_id: String,
    pub source: String,
    pub target: String,
    pub source_handle: Option<HandleSide>,
    pub target_handle: Option<HandleSide>,
    pub label: Option<String>,
}

/// Прогресс подзадач задачи: задачи (`kind = task`) её **прямого** вложенного
/// холста — `done` из `total`. Заметки и более глубокие уровни не считаются.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProgress {
    pub node_id: String,
    pub done: i64,
    pub total: i64,
}

/// Результат `load_canvas`: всё, что нужно для отрисовки одного холста.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasData {
    pub canvas: Canvas,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Прогресс подзадач для нод этого холста (только у задач, где `total > 0`).
    pub progress: Vec<NodeProgress>,
}

/// Один вложенный холст поддерева (`load_subtree`) — для «просвечивания» слоёв (ТЗ §4.5.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtreeLevel {
    /// Холст; `canvas.owner_node` — задача-владелец (лежит на уровень выше).
    pub canvas: Canvas,
    /// 1 — прямые подзадачи нод исходного холста, 2 — их подзадачи, …
    pub depth: u32,
    /// Заголовки задач-владельцев от исходного холста до этого: `["Задача A", "Подзадача B"]`.
    pub path: Vec<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub progress: Vec<NodeProgress>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNode {
    pub canvas_id: String,
    pub kind: NodeKind,
    #[serde(default)]
    pub title: String,
    pub x: f64,
    pub y: f64,
}

/// Частичное обновление ноды. Отсутствующее поле — не трогать.
/// Для nullable-полей (`status`, `color`, `width`, `height`) явный `null` — сбросить.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub status: Option<Option<TaskStatus>>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub width: Option<Option<f64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub height: Option<Option<f64>>,
    /// Путь в vault (`a/b.md` или папка `a/b`); `null` — отвязать.
    #[serde(default, deserialize_with = "double_option")]
    pub kb_path: Option<Option<String>>,
    /// «Результат» задачи (ТЗ §4.11); `null` — отвязать. У заметки — ошибка.
    #[serde(default, deserialize_with = "double_option")]
    pub kb_result_path: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodePosition {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEdge {
    pub canvas_id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub source_handle: Option<HandleSide>,
    #[serde(default)]
    pub target_handle: Option<HandleSide>,
}

/// Отличает «поле отсутствует» (`None`) от «поле = null» (`Some(None)`).
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

/// Задача пространства для обзора задач (`list_space_tasks`, ТЗ §4.6.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceTask {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub color: Option<String>,
    /// Холст, на котором лежит задача.
    pub canvas_id: String,
    /// Задача-владелец этого холста; `None` — корневой холст пространства.
    pub parent_node_id: Option<String>,
    /// 0 — корневой холст, 1 — подзадачи, …
    pub depth: u32,
    pub x: f64,
    pub y: f64,
    pub created_at: i64,
}

/// Нода, привязанная к файлу/папке базы знаний (`kb_linked_nodes`, правая панель «Ноды графа»).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedNode {
    pub id: String,
    pub title: String,
    pub kind: NodeKind,
    pub status: Option<TaskStatus>,
    pub space_id: String,
    pub space_name: String,
    /// Цепочка холстов от корневого холста пространства до холста ноды
    /// (готовый аргумент для `revealNode` на фронте).
    pub canvas_chain: Vec<String>,
    /// Роль ссылки. Задача, у которой путь — и комментарий, и результат,
    /// приходит двумя записями.
    pub role: LinkRole,
}

/// «Результат» задачи для фильтра проводника (`kb_result_links`, ТЗ §4.11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultLink {
    /// Путь результата в vault (заметка или папка).
    pub path: String,
    /// Задача-владелец ссылки.
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub space_id: String,
    pub space_name: String,
    /// Заголовки задач-предков от корня пространства (без самой задачи):
    /// тултип `Пространство › Задача A › Подзадача B`.
    pub parents: Vec<String>,
    /// Цепочка холстов от корневого до холста задачи (для `revealNode`).
    pub canvas_chain: Vec<String>,
}
