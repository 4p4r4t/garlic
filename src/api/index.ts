// Типизированные обёртки над командами Tauri (src-tauri/src/commands.rs).
// Аргументы команд Tauri принимает в camelCase и сам маппит в snake_case.

import { invoke as rawInvoke } from "@tauri-apps/api/core";

import { serial, serialVault } from "./queue";

import type {
  Backlink,
  Canvas,
  CanvasData,
  EdgeModel,
  KbStat,
  LinkTarget,
  LinkedNode,
  NewEdge,
  NewNode,
  NodeModel,
  NodePatch,
  NodePosition,
  NoteFile,
  SearchHit,
  Space,
  SpaceTask,
  SubtreeLevel,
  TaskStatus,
  VaultEntry,
  VaultInfo,
  Viewport,
} from "./types";

export * from "./types";

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return serial(() => rawInvoke<T>(cmd, args));
}

/** Изменения vault — по своей очереди; чтение/поиск — без очереди. */
function invokeVault<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return serialVault(() => rawInvoke<T>(cmd, args));
}

/** Ключи app_state. */
export const APP_STATE = {
  activeSpace: "active_space",
  /** "1"/"0" — показывать ли вложенные уровни на текущем холсте (ТЗ §4.5.1). */
  showNested: "show_nested",
  /** JSON `{todo, in_progress, done}` — ключ палитры или null: заливка по статусу (ТЗ §4.3). */
  statusColors: "status_colors",
  /** "graph" | "kb" — режим окна (ТЗ §4.10). */
  mode: "ui.mode",
  /** JSON состояния режима «База»: вкладки, раскрытые папки, панели. */
  kbUi: "kb.ui",
  /** Абсолютный путь vault (пишет `vault_set_path`). */
  vaultPath: "kb.vault_path",
  /** Папка по умолчанию для новых заметок из графа (M5.2), путь в vault. */
  kbDefaultFolder: "kb.default_folder",
} as const;

/** Tauri-событие watcher'а с пачкой `VaultEvent[]`. */
export const VAULT_EVENT = "vault:changed";

export const api = {
  // пространства
  listSpaces: () => invoke<Space[]>("list_spaces"),
  createSpace: (name: string) => invoke<Space>("create_space", { name }),
  renameSpace: (id: string, name: string) => invoke<Space>("rename_space", { id, name }),
  deleteSpace: (id: string) => invoke<void>("delete_space", { id }),

  // холсты
  loadCanvas: (canvasId: string) => invoke<CanvasData>("load_canvas", { canvasId }),
  loadSubtree: (canvasId: string, maxDepth: number) =>
    invoke<SubtreeLevel[]>("load_subtree", { canvasId, maxDepth }),
  getOrCreateChildCanvas: (nodeId: string) =>
    invoke<Canvas>("get_or_create_child_canvas", { nodeId }),
  saveViewport: (canvasId: string, viewport: Viewport) =>
    invoke<void>("save_viewport", { canvasId, viewport }),

  // ноды
  createNode: (input: NewNode) => invoke<NodeModel>("create_node", { input }),
  updateNode: (id: string, patch: NodePatch) => invoke<NodeModel>("update_node", { id, patch }),
  /** Пакетная смена статуса; заметки пропускаются. Возвращает обновлённые задачи. */
  setStatusMany: (ids: string[], status: TaskStatus) =>
    invoke<NodeModel[]>("set_status_many", { ids, status }),
  moveNodes: (positions: NodePosition[]) => invoke<void>("move_nodes", { positions }),
  deleteNodes: (ids: string[]) => invoke<number>("delete_nodes", { ids }),
  countDescendants: (nodeId: string) => invoke<number>("count_descendants", { nodeId }),

  // связи
  createEdge: (input: NewEdge) => invoke<EdgeModel>("create_edge", { input }),
  deleteEdges: (ids: string[]) => invoke<number>("delete_edges", { ids }),

  // состояние приложения
  getAppState: (key: string) => invoke<string | null>("get_app_state", { key }),
  setAppState: (key: string, value: string) => invoke<void>("set_app_state", { key, value }),

  // обзор задач (ТЗ §4.6.1)
  listSpaceTasks: (spaceId: string) => invoke<SpaceTask[]>("list_space_tasks", { spaceId }),

  // база знаний (ТЗ §4.10). Пути — относительно vault, `/`; папка-корень — "".
  vaultInfo: () => rawInvoke<VaultInfo>("vault_info"),
  /** Сменить папку vault (создаётся при отсутствии), перезапустить слежение. */
  vaultSetPath: (path: string) => invokeVault<VaultInfo>("vault_set_path", { path }),
  vaultTree: () => rawInvoke<VaultEntry[]>("vault_tree"),
  vaultRead: (path: string) => rawInvoke<NoteFile>("vault_read", { path }),
  /**
   * Атомарная запись; → новый mtime. Эхо этой записи watcher во фронт не шлёт.
   * `expectedMtime` — последний известный mtime: файл изменён снаружи → ошибка `conflict: …`.
   */
  vaultWrite: (path: string, content: string, expectedMtime?: number | null) =>
    invokeVault<number>("vault_write", { path, content, expectedMtime: expectedMtime ?? null }),
  /** Новая заметка в `dir` (имя очищается, ` 2`/` 3` при занятом) → её путь. */
  vaultCreateNote: (dir: string, name: string, content?: string) =>
    invokeVault<string>("vault_create_note", { dir, name, content: content ?? null }),
  /** Новая папка в `dir` → её путь. */
  vaultCreateFolder: (dir: string, name: string) =>
    invokeVault<string>("vault_create_folder", { dir, name }),
  /** Переименование (у заметки имя без .md); kb_path нод переписываются → новый путь. */
  vaultRename: (path: string, newName: string) =>
    invokeVault<string>("vault_rename", { path, newName }),
  /** Перемещение в папку (`""` — корень); kb_path нод переписываются → новый путь. */
  vaultMove: (path: string, newDir: string) => invokeVault<string>("vault_move", { path, newDir }),
  /** В корзину ОС. */
  vaultDelete: (path: string) => invokeVault<void>("vault_delete", { path }),
  vaultSearch: (query: string, limit?: number) =>
    rawInvoke<SearchHit[]>("vault_search", { query, limit: limit ?? null }),
  vaultBacklinks: (path: string) => rawInvoke<Backlink[]>("vault_backlinks", { path }),
  vaultAbsPath: (path: string) => rawInvoke<string>("vault_abs_path", { path }),
  /** Ноды всех пространств с kb_path == path. */
  kbLinkedNodes: (path: string) => invoke<LinkedNode[]>("kb_linked_nodes", { path }),

  // ссылки нод (ТЗ §4.10, M5.2): операции с путём, запись в ноду — updateNode.
  /** Новая заметка/папка для поля-ссылки в `dir` (null — папка по умолчанию; создаётся) → путь. */
  kbCreateTarget: (kind: LinkTarget, dir: string | null, name: string) =>
    invokeVault<string>("kb_create_target", { kind, dir, name }),
  /** «Заметка → папка»: папка рядом с заметкой, заметка внутрь, ссылки нод переписаны → путь папки. */
  kbNoteToFolder: (path: string, folderName: string) =>
    invokeVault<string>("kb_note_to_folder", { path, folderName }),
  /** Существование путей и превью заметок. */
  kbStat: (paths: string[]) => rawInvoke<KbStat[]>("kb_stat", { paths }),
};

/** Ошибка записи из-за изменения файла снаружи (`AppError::Conflict`). */
export const isConflictError = (e: unknown) => errorMessage(e).startsWith("conflict:");

/** Текст ошибки из команды (AppError сериализуется строкой). */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
