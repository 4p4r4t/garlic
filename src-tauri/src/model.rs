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
    /// «Заблокирована» (ТЗ §4.12.7): ставится только блокировкой — у задачи есть
    /// незавершённый блокирующий (стикер или стрелка «блокирует»).
    Blocked,
    /// «Чужая» (ТЗ §4.12.7): чужая работа; стикер-причина блокировки.
    Foreign,
}

impl TaskStatus {
    /// Статус, который нельзя поставить напрямую (только блокировкой).
    pub fn is_blocked(self) -> bool {
        self == Self::Blocked
    }
}

/// Вид стрелки (ТЗ §4.12.7): обычная или «блокирует» (оторванный стикер →
/// заблокированная задача, пунктир).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    #[default]
    Link,
    Blocks,
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
str_enum!(TaskStatus { Todo => "todo", InProgress => "in_progress", Done => "done", Blocked => "blocked", Foreign => "foreign" });
str_enum!(EdgeKind { Link => "link", Blocks => "blocks" });
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
    /// `None` для корневого холста пространства и «ничейного» слоя.
    pub owner_node: Option<String>,
    /// Только у «ничейного» слоя (ТЗ §4.12.3): холст, на котором лежал бывший
    /// родитель. У корневого и обычных вложенных холстов — `None`.
    #[serde(default)]
    pub host_canvas: Option<String>,
    pub viewport: Viewport,
}

impl Canvas {
    /// «Ничейный» слой: родителя нет, но это не корневой холст.
    pub fn is_orphan(&self) -> bool {
        self.owner_node.is_none() && self.host_canvas.is_some()
    }
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
    /// Только у заблокированной задачи: статус, в который она вернётся при
    /// разблокировке (ТЗ §4.12.7).
    #[serde(default)]
    pub prev_status: Option<TaskStatus>,
    /// Стикер (ТЗ §4.12.7): задача, к которой он прикреплён. Тогда `x`/`y` —
    /// смещение от левого верхнего угла этой задачи, а не мировые координаты.
    #[serde(default)]
    pub sticker_of: Option<String>,
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
    #[serde(default)]
    pub kind: EdgeKind,
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
    #[serde(default)]
    pub kind: EdgeKind,
    /// Заданный id (повтор отменённого шага); `None` — новый.
    #[serde(default)]
    pub id: Option<String>,
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

/// Нода для поиска по графу (`list_graph_nodes`, ТЗ §9 M6b).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeHit {
    pub id: String,
    pub title: String,
    pub kind: NodeKind,
    /// Только у задач.
    pub status: Option<TaskStatus>,
    pub space_id: String,
    pub space_name: String,
    pub canvas_id: String,
    /// Холсты от корневого холста пространства до холста ноды (аргумент `revealNode`).
    pub canvas_chain: Vec<String>,
    /// Заголовки задач-владельцев от корня пространства (без самой ноды).
    pub parents: Vec<String>,
}

/// Задача для боковой панели списков (`list_all_tasks`, ТЗ §4.12.5): из любого пространства.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTask {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub color: Option<String>,
    pub canvas_id: String,
    pub parent_node_id: Option<String>,
    pub space_id: String,
    pub space_name: String,
    /// Заголовки предков от корня пространства (без самой задачи).
    pub parents: Vec<String>,
    /// Цепочка холстов от корневого холста пространства до холста задачи.
    pub canvas_chain: Vec<String>,
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

/// Снимок части графа для undo/redo (ТЗ M6a): ноды вместе со всеми вложенными
/// холстами (поддеревья подзадач) и всеми связями, касающимися этих нод, плюс
/// явно указанные связи. `restore_graph` возвращает всё с теми же id.
/// Холст того же уровня, что и текущий слой (`load_level_neighbors`, ТЗ §4.12.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborLevel {
    pub canvas: Canvas,
    /// Заголовок задачи-владельца (подпись соседей); у ничейного слоя — `None`.
    pub parent_title: Option<String>,
    /// Цепочка холстов от корневого до этого (стек слоёв для перехода).
    pub canvas_chain: Vec<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub progress: Vec<NodeProgress>,
}

/// Вложенная нода с положением (`list_descendants`, групповое перемещение ТЗ §4.12.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePlace {
    pub id: String,
    pub canvas_id: String,
    pub x: f64,
    pub y: f64,
}

/// Судьба подзадач при удалении задачи-родителя (ТЗ §4.12.3). «Удалить
/// подзадачи» — обычное `delete_nodes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteMode {
    /// «Перенести на уровень родителя»: подзадачи — на холст удаляемой задачи.
    Lift,
    /// «Не трогать»: слой подзадач становится ничейным.
    Orphan,
}

/// Состояние набора холстов «как есть» (без поддеревьев — они висят на своих
/// владельцах): строки холстов, их ноды и связи. Основа undo/redo операций,
/// которые переносят ноды между холстами (ТЗ §4.12.3).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionSnapshot {
    /// Холсты области. Холст из `region`, которого нет в `canvases`, при
    /// применении снимка удаляется.
    pub region: Vec<String>,
    pub canvases: Vec<Canvas>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// Результат перестройки: область до и после (undo — `apply_region(before)`,
/// redo — `apply_region(after)`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionChange {
    pub before: RegionSnapshot,
    pub after: RegionSnapshot,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    /// Вложенные холсты, по возрастанию глубины.
    pub canvases: Vec<Canvas>,
    /// Сначала сами ноды (в порядке запроса), затем ноды вложенных холстов.
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// Итог пересчёта блокировок (`repo::blocks::sync`): задачи, которые стали
/// заблокированными и которые разблокировались (с новым статусом).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSync {
    pub blocked: Vec<Node>,
    pub unblocked: Vec<Node>,
}

impl BlockSync {
    pub fn is_empty(&self) -> bool {
        self.blocked.is_empty() && self.unblocked.is_empty()
    }
}

/// Результат `stick`: стикер (или освобождённая нода) и созданная стрелка «блокирует».
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickResult {
    pub node: Node,
    pub edge: Option<Edge>,
}
