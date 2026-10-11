// Zustand-стор графа. Фронт хранит только кэш открытых холстов (ключ — canvas id),
// источник правды — SQLite через команды Tauri.

import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { create } from "zustand";

import {
  api,
  APP_STATE,
  errorMessage,
  type Canvas,
  type CanvasData,
  type HandleSide,
  type NodeKind,
  type NodeModel,
  type NodePatch,
  type NodePosition,
  type Space,
  type TaskStatus,
  type Viewport,
} from "../api";
import { toFlowEdge, toFlowNode, type FlowEdge, type FlowNode } from "../canvas/flow";

export interface CanvasView {
  canvas: Canvas;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface EdgeEnds {
  source: string;
  target: string;
  sourceHandle: HandleSide | null;
  targetHandle: HandleSide | null;
}

const MOVE_DEBOUNCE_MS = 300;
const VIEWPORT_DEBOUNCE_MS = 400;
const TOAST_MS = 4000;

export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

interface GraphState {
  phase: "loading" | "ready" | "error";
  fatal: string | null;
  toast: string | null;

  spaces: Space[];
  activeSpaceId: string | null;
  /** Стек слоёв (id холстов): [корневой, ...вложенные]. Активный — последний. Слои — M3. */
  layers: string[];
  /** Кэш загруженных холстов. */
  canvases: Record<string, CanvasView>;
  /** Нода, заголовок которой сейчас редактируется. */
  editingNodeId: string | null;

  init: () => Promise<void>;
  loadCanvas: (canvasId: string) => Promise<void>;

  onNodesChange: (canvasId: string, changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (canvasId: string, changes: EdgeChange<FlowEdge>[]) => void;

  /** Создаёт ноду; возвращает её модель (null — ошибка уже показана). */
  createNode: (
    canvasId: string,
    kind: NodeKind,
    pos: { x: number; y: number },
  ) => Promise<NodeModel | null>;
  /** Создаёт ноду и сразу стрелку к ней от `from` (ТЗ §4.2.1, стрелка в пустое место). */
  createConnectedNode: (
    canvasId: string,
    kind: NodeKind,
    pos: { x: number; y: number },
    from: { nodeId: string; handle: HandleSide | null },
    targetHandle: HandleSide,
  ) => Promise<void>;
  updateNode: (canvasId: string, id: string, patch: NodePatch) => Promise<void>;
  cycleStatus: (canvasId: string, id: string) => void;
  queueMove: (canvasId: string, positions: NodePosition[]) => void;
  connect: (canvasId: string, ends: EdgeEnds) => Promise<void>;
  /** Сохраняет удаление (локально элементы уже убраны через on*Change). */
  persistDelete: (canvasId: string, nodeIds: string[], edgeIds: string[]) => Promise<void>;
  /** Вьюпорт один на пространство (ТЗ §1/§6): пишется в корневой холст пространства canvasId. */
  queueViewport: (canvasId: string, viewport: Viewport) => void;

  // --- пространства (M4) ---
  /** Переключиться: сброс стека слоёв, загрузка корневого холста, запоминание в app_state. */
  switchSpace: (spaceId: string) => Promise<void>;
  /** Создать и сразу переключиться. Возвращает false при ошибке. */
  createSpace: (name: string) => Promise<boolean>;
  renameSpace: (spaceId: string, name: string) => Promise<boolean>;
  /** Удалить (последнее нельзя). Текущее — сначала переключаемся на соседнее. */
  deleteSpace: (spaceId: string) => Promise<void>;

  startEditing: (nodeId: string) => void;
  stopEditing: () => void;

  /** Вход в слой подзадач задачи (ТЗ §4.5). Заглушка: реализуется в M3. */
  enterLayer: (nodeId: string) => void;

  showError: (e: unknown) => void;
  dismissToast: () => void;
}

function toView(data: CanvasData): CanvasView {
  return {
    canvas: data.canvas,
    nodes: data.nodes.map(toFlowNode),
    edges: data.edges.map(toFlowEdge),
  };
}

// --- отложенная запись (дебаунс) ---
const pendingMoves = new Map<string, Map<string, NodePosition>>();
const moveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingViewports = new Map<string, Viewport>();
const viewportTimers = new Map<string, ReturnType<typeof setTimeout>>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let initPromise: Promise<void> | null = null;
/** Номер последнего переключения пространства — поздние ответы старых переключений игнорируются. */
let switchSeq = 0;

export const useGraph = create<GraphState>()((set, get) => {
  /** Применяет fn к холсту из кэша (если он загружен). */
  const patchView = (canvasId: string, fn: (v: CanvasView) => CanvasView) =>
    set((s) => {
      const v = s.canvases[canvasId];
      return v ? { canvases: { ...s.canvases, [canvasId]: fn(v) } } : {};
    });

  const setModel = (canvasId: string, id: string, fn: (m: NodeModel) => NodeModel) =>
    patchView(canvasId, (v) => ({
      ...v,
      nodes: v.nodes.map((n) => (n.id === id ? { ...n, data: { model: fn(n.data.model) } } : n)),
    }));

  /** Ошибка записи: показать и перечитать холст из БД, чтобы не разойтись с ней. */
  const fail = (canvasId: string, e: unknown) => {
    get().showError(e);
    void get().loadCanvas(canvasId);
  };

  const flushMoves = (canvasId: string) => {
    moveTimers.delete(canvasId);
    const batch = pendingMoves.get(canvasId);
    pendingMoves.delete(canvasId);
    if (!batch || batch.size === 0) return;
    api.moveNodes([...batch.values()]).catch((e) => fail(canvasId, e));
  };

  const flushViewport = (canvasId: string) => {
    viewportTimers.delete(canvasId);
    const vp = pendingViewports.get(canvasId);
    pendingViewports.delete(canvasId);
    if (!vp) return;
    patchView(canvasId, (v) => ({ ...v, canvas: { ...v.canvas, viewport: vp } }));
    api.saveViewport(canvasId, vp).catch((e) => get().showError(e));
  };

  /** Отправить все отложенные записи сразу (очередь команд последовательна — они уйдут раньше следующих). */
  const flushAll = () => {
    [...moveTimers.keys()].forEach((id) => {
      clearTimeout(moveTimers.get(id));
      flushMoves(id);
    });
    [...viewportTimers.keys()].forEach((id) => {
      clearTimeout(viewportTimers.get(id));
      flushViewport(id);
    });
  };

  /** Корневой холст пространства, которому принадлежит canvasId (для вьюпорта). */
  const rootCanvasOf = (canvasId: string): string => {
    const s = get();
    const spaceId = s.canvases[canvasId]?.canvas.spaceId;
    const space = s.spaces.find((sp) => sp.id === spaceId);
    return space?.rootCanvas ?? canvasId;
  };

  // Лучшее, что можно сделать при закрытии окна: отправить отложенное сразу.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushAll);
  }

  return {
    phase: "loading",
    fatal: null,
    toast: null,
    spaces: [],
    activeSpaceId: null,
    layers: [],
    canvases: {},
    editingNodeId: null,

    init: () => {
      // StrictMode вызывает эффекты дважды — инициализируемся один раз.
      initPromise ??= (async () => {
        try {
          const spaces = await api.listSpaces();
          if (spaces.length === 0) throw new Error("не найдено ни одного пространства");
          const saved = await api.getAppState(APP_STATE.activeSpace);
          const space = spaces.find((s) => s.id === saved) ?? spaces[0];
          if (space.id !== saved) await api.setAppState(APP_STATE.activeSpace, space.id);
          const data = await api.loadCanvas(space.rootCanvas);
          set({
            phase: "ready",
            spaces,
            activeSpaceId: space.id,
            layers: [space.rootCanvas],
            canvases: { [space.rootCanvas]: toView(data) },
          });
        } catch (e) {
          set({ phase: "error", fatal: errorMessage(e) });
        }
      })();
      return initPromise;
    },

    loadCanvas: async (canvasId) => {
      try {
        const data = await api.loadCanvas(canvasId);
        set((s) => ({ canvases: { ...s.canvases, [canvasId]: toView(data) } }));
      } catch (e) {
        get().showError(e);
      }
    },

    onNodesChange: (canvasId, changes) =>
      patchView(canvasId, (v) => ({ ...v, nodes: applyNodeChanges(changes, v.nodes) })),

    onEdgesChange: (canvasId, changes) =>
      patchView(canvasId, (v) => ({ ...v, edges: applyEdgeChanges(changes, v.edges) })),

    createNode: async (canvasId, kind, pos) => {
      try {
        const model = await api.createNode({ canvasId, kind, x: pos.x, y: pos.y });
        patchView(canvasId, (v) => ({ ...v, nodes: [...v.nodes, toFlowNode(model)] }));
        // Новая задача сразу открывается на редактирование заголовка (ТЗ §4.2).
        if (kind === "task") set({ editingNodeId: model.id });
        return model;
      } catch (e) {
        get().showError(e);
        return null;
      }
    },

    createConnectedNode: async (canvasId, kind, pos, from, targetHandle) => {
      const model = await get().createNode(canvasId, kind, pos);
      if (!model) return;
      await get().connect(canvasId, {
        source: from.nodeId,
        target: model.id,
        sourceHandle: from.handle,
        targetHandle,
      });
    },

    updateNode: async (canvasId, id, patch) => {
      // Оптимистично: сразу в UI, при ошибке — перечитать холст.
      setModel(canvasId, id, (m) => ({ ...m, ...patch }));
      try {
        const fresh = await api.updateNode(id, patch);
        // Позиция живёт в FlowNode.position, поэтому x/y из ответа не мешают.
        setModel(canvasId, id, (m) => ({ ...fresh, x: m.x, y: m.y }));
      } catch (e) {
        fail(canvasId, e);
      }
    },

    cycleStatus: (canvasId, id) => {
      const node = get().canvases[canvasId]?.nodes.find((n) => n.id === id);
      const status = node?.data.model.status;
      if (!node || node.data.model.kind !== "task" || !status) return;
      void get().updateNode(canvasId, id, { status: NEXT_STATUS[status] });
    },

    queueMove: (canvasId, positions) => {
      let batch = pendingMoves.get(canvasId);
      if (!batch) pendingMoves.set(canvasId, (batch = new Map()));
      for (const p of positions) batch.set(p.id, p);
      clearTimeout(moveTimers.get(canvasId));
      moveTimers.set(
        canvasId,
        setTimeout(() => flushMoves(canvasId), MOVE_DEBOUNCE_MS),
      );
    },

    connect: async (canvasId, ends) => {
      const view = get().canvases[canvasId];
      if (!view || ends.source === ends.target) return;
      // Дубли (та же пара source → target) запрещены и в Rust — тихо игнорируем.
      if (view.edges.some((e) => e.source === ends.source && e.target === ends.target)) return;
      try {
        const edge = await api.createEdge({ canvasId, ...ends });
        patchView(canvasId, (v) =>
          v.edges.some((e) => e.id === edge.id) ? v : { ...v, edges: [...v.edges, toFlowEdge(edge)] },
        );
      } catch (e) {
        get().showError(e);
      }
    },

    persistDelete: async (canvasId, nodeIds, edgeIds) => {
      const batch = pendingMoves.get(canvasId);
      nodeIds.forEach((id) => batch?.delete(id));
      if (nodeIds.includes(get().editingNodeId ?? "")) set({ editingNodeId: null });
      try {
        // Связи удалённых нод уходят каскадом; неизвестные id Rust игнорирует.
        if (edgeIds.length) await api.deleteEdges(edgeIds);
        if (nodeIds.length) await api.deleteNodes(nodeIds);
      } catch (e) {
        fail(canvasId, e);
      }
    },

    queueViewport: (layerCanvasId, viewport) => {
      const canvasId = rootCanvasOf(layerCanvasId);
      pendingViewports.set(canvasId, viewport);
      clearTimeout(viewportTimers.get(canvasId));
      viewportTimers.set(
        canvasId,
        setTimeout(() => flushViewport(canvasId), VIEWPORT_DEBOUNCE_MS),
      );
    },

    switchSpace: async (spaceId) => {
      const space = get().spaces.find((sp) => sp.id === spaceId);
      if (!space) return;
      const seq = ++switchSeq;
      // Отложенные перемещения/вьюпорт текущего пространства — в БД до загрузки нового.
      flushAll();
      try {
        const data = await api.loadCanvas(space.rootCanvas);
        if (seq !== switchSeq) return;
        // Кэш холстов сбрасываем целиком: всё отложенное уже ушло в очередь записи.
        set({
          activeSpaceId: space.id,
          layers: [space.rootCanvas],
          canvases: { [space.rootCanvas]: toView(data) },
          editingNodeId: null,
        });
        await api.setAppState(APP_STATE.activeSpace, space.id);
      } catch (e) {
        get().showError(e);
      }
    },

    createSpace: async (name) => {
      try {
        const space = await api.createSpace(name);
        set((s) => ({ spaces: [...s.spaces, space] }));
        await get().switchSpace(space.id);
        return true;
      } catch (e) {
        get().showError(e);
        return false;
      }
    },

    renameSpace: async (spaceId, name) => {
      try {
        const fresh = await api.renameSpace(spaceId, name);
        set((s) => ({ spaces: s.spaces.map((sp) => (sp.id === fresh.id ? fresh : sp)) }));
        return true;
      } catch (e) {
        get().showError(e);
        return false;
      }
    },

    deleteSpace: async (spaceId) => {
      const { spaces, activeSpaceId } = get();
      const idx = spaces.findIndex((sp) => sp.id === spaceId);
      if (idx < 0) return;
      if (spaces.length <= 1) {
        get().showError("нельзя удалить последнее пространство");
        return;
      }
      if (spaceId === activeSpaceId) {
        // Соседнее: следующее по списку, а у последнего — предыдущее.
        const other = spaces[idx + 1] ?? spaces[idx - 1];
        await get().switchSpace(other.id);
        if (get().activeSpaceId === spaceId) return; // переключиться не удалось
      } else {
        flushAll();
      }
      try {
        await api.deleteSpace(spaceId);
        set((s) => ({
          spaces: s.spaces.filter((sp) => sp.id !== spaceId),
          canvases: Object.fromEntries(
            Object.entries(s.canvases).filter(([, v]) => v.canvas.spaceId !== spaceId),
          ),
        }));
      } catch (e) {
        get().showError(e);
      }
    },

    startEditing: (nodeId) => set({ editingNodeId: nodeId }),
    stopEditing: () => set({ editingNodeId: null }),

    // TODO(M3): стек слоёв — get_or_create_child_canvas + push в `layers`.
    enterLayer: () => {},

    showError: (e) => {
      const msg = errorMessage(e);
      console.error("[garlic]", msg);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ toast: null }), TOAST_MS);
      set({ toast: msg });
    },
    dismissToast: () => set({ toast: null }),
  };
});
