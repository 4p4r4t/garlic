// Зеркало src-tauri/src/model.rs — держать синхронным.

export type NodeKind = "task" | "note";
export type TaskStatus = "todo" | "in_progress" | "done";
export type HandleSide = "top" | "right" | "bottom" | "left";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Space {
  id: string;
  name: string;
  rootCanvas: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface Canvas {
  id: string;
  spaceId: string;
  /** null у корневого холста пространства */
  ownerNode: string | null;
  viewport: Viewport;
}

export interface NodeModel {
  id: string;
  canvasId: string;
  kind: NodeKind;
  title: string;
  body: string;
  /** только у task */
  status: TaskStatus | null;
  color: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  /** Ссылка на заметку/папку базы знаний: путь относительно vault (`/`), ТЗ §4.10. */
  kbPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EdgeModel {
  id: string;
  canvasId: string;
  source: string;
  target: string;
  sourceHandle: HandleSide | null;
  targetHandle: HandleSide | null;
  label: string | null;
}

/** Прогресс подзадач: задачи прямого вложенного холста (`done` из `total`). */
export interface NodeProgress {
  nodeId: string;
  done: number;
  total: number;
}

export interface CanvasData {
  canvas: Canvas;
  nodes: NodeModel[];
  edges: EdgeModel[];
  /** Только задачи, у которых в прямом вложенном холсте есть задачи. */
  progress: NodeProgress[];
}

/** Один вложенный холст поддерева (`load_subtree`, ТЗ §4.5.1). */
export interface SubtreeLevel {
  /** `canvas.ownerNode` — задача-владелец уровнем выше. */
  canvas: Canvas;
  /** 1 — прямые подзадачи нод исходного холста, 2 — их подзадачи, … */
  depth: number;
  /** Заголовки задач-владельцев от исходного холста: ["Задача A", "Подзадача B"]. */
  path: string[];
  nodes: NodeModel[];
  edges: EdgeModel[];
  progress: NodeProgress[];
}

export interface NewNode {
  canvasId: string;
  kind: NodeKind;
  title?: string;
  x: number;
  y: number;
}

/** Отсутствующее поле — не менять; null у nullable-полей — сбросить. */
export interface NodePatch {
  title?: string;
  body?: string;
  status?: TaskStatus | null;
  color?: string | null;
  width?: number | null;
  height?: number | null;
  /** Путь в vault (`a/b.md` или папка `a/b`); null — отвязать. */
  kbPath?: string | null;
}

export interface NodePosition {
  id: string;
  x: number;
  y: number;
}

export interface NewEdge {
  canvasId: string;
  source: string;
  target: string;
  sourceHandle: HandleSide | null;
  targetHandle: HandleSide | null;
}

/** Задача пространства для обзора задач (`list_space_tasks`, ТЗ §4.6.1). */
export interface SpaceTask {
  id: string;
  title: string;
  status: TaskStatus;
  color: string | null;
  /** Холст, на котором лежит задача. */
  canvasId: string;
  /** Задача-владелец холста; null — корневой холст пространства. */
  parentNodeId: string | null;
  /** 0 — корневой холст, 1 — подзадачи, … */
  depth: number;
  x: number;
  y: number;
  createdAt: number;
}

// ---- база знаний (ТЗ §4.10), src-tauri/src/vault/mod.rs ----

export type VaultEntryKind = "folder" | "note";

export interface VaultEntry {
  /** Имя на диске (у заметки — с `.md`). */
  name: string;
  /** Путь относительно корня vault, разделитель `/`. */
  path: string;
  kind: VaultEntryKind;
  mtime: number;
  /** Только у папок. */
  children: VaultEntry[] | null;
}

export interface NoteFile {
  path: string;
  content: string;
  mtime: number;
}

export interface SearchLine {
  /** Номер строки, с 0. */
  line: number;
  text: string;
}

export interface SearchHit {
  path: string;
  nameMatch: boolean;
  /** Всего строк с совпадением (в `lines` — первые несколько). */
  total: number;
  lines: SearchLine[];
}

export interface Backlink {
  path: string;
  lines: SearchLine[];
}

export type VaultEventKind = "create" | "modify" | "remove" | "rename";

/** Событие watcher'а (Tauri-событие `vault:changed`, пачкой). */
export interface VaultEvent {
  kind: VaultEventKind;
  /** Путь (у rename — новый). */
  path: string;
  /** Старый путь у rename. */
  from: string | null;
  /** Папка (у удалённого всегда false). */
  isDir: boolean;
}

export interface VaultInfo {
  root: string;
  ok: boolean;
  error: string | null;
}

/** Нода, привязанная к заметке/папке (`kb_linked_nodes`). */
export interface LinkedNode {
  id: string;
  title: string;
  kind: NodeKind;
  status: TaskStatus | null;
  spaceId: string;
  spaceName: string;
  /** Холсты от корневого холста пространства до холста ноды — аргумент `revealNode`. */
  canvasChain: string[];
}
