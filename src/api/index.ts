// Типизированные обёртки над командами Tauri (src-tauri/src/commands.rs).
// Аргументы команд Tauri принимает в camelCase и сам маппит в snake_case.

import { invoke as rawInvoke } from "@tauri-apps/api/core";

import { serial } from "./queue";

import type {
  Canvas,
  CanvasData,
  EdgeModel,
  NewEdge,
  NewNode,
  NodeModel,
  NodePatch,
  NodePosition,
  Space,
  SubtreeLevel,
  TaskStatus,
  Viewport,
} from "./types";

export * from "./types";

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return serial(() => rawInvoke<T>(cmd, args));
}

/** Ключи app_state. */
export const APP_STATE = {
  activeSpace: "active_space",
  /** "1"/"0" — показывать ли вложенные уровни на текущем холсте (ТЗ §4.5.1). */
  showNested: "show_nested",
  /** JSON `{todo, in_progress, done}` — ключ палитры или null: заливка по статусу (ТЗ §4.3). */
  statusColors: "status_colors",
} as const;

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
};

/** Текст ошибки из команды (AppError сериализуется строкой). */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
