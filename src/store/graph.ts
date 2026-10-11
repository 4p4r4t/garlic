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
  type SubtreeLevel,
  type TaskStatus,
  type Viewport,
} from "../api";
import {
  progressMap,
  progressOf,
  toFlowEdge,
  toFlowNode,
  type FlowEdge,
  type FlowNode,
} from "../canvas/flow";
import {
  DEFAULT_STATUS_COLORS,
  parseStatusColors,
  type StatusColors,
} from "../canvas/palette";
import { viewportBus } from "../layers/viewportBus";

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

/** Сколько вложенных уровней просвечивает на текущем холсте (ТЗ §4.5.1). */
export const SEE_THROUGH_MAX_DEPTH = 3;

/** Поддерево верхнего холста для просвечивания. */
export interface SubtreeState {
  canvasId: string;
  levels: SubtreeLevel[];
}

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
  /** Стек слоёв (id холстов): [корневой, ...вложенные]. Активный — последний (ТЗ §4.5). */
  layers: string[];
  /** Вложенные уровни верхнего холста (просвечивание); null — выключено. */
  subtree: SubtreeState | null;
  /** Показывать ли вложенные уровни (переключатель в топбаре, app_state.show_nested). */
  showNested: boolean;
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

  // --- слои подзадач (M3) ---
  /** Вход в слой подзадач задачи верхнего холста (ТЗ §4.5). */
  enterLayer: (nodeId: string) => Promise<void>;
  /** Выход: уровень `index` стека становится верхним (0 — корневой холст). */
  exitTo: (index: number) => Promise<void>;
  /** «Проваливание» в просвечивающую ноду: цепочка слоёв до её холста, нода выделяется. */
  diveTo: (nodeId: string) => Promise<void>;
  setShowNested: (show: boolean) => Promise<void>;

  showError: (e: unknown) => void;
  dismissToast: () => void;

  // --- v1.2: групповые действия, цвета статусов ---
  /** Цвет заливки по статусу (настройки, app_state.status_colors). */
  statusColors: StatusColors;
  setStatusColor: (status: TaskStatus, color: string | null) => Promise<void>;
  /** Статус всем задачам из ids (заметки пропускаются) одним пакетом. */
  setStatusMany: (canvasId: string, ids: string[], status: TaskStatus) => Promise<void>;
}

function toView(data: CanvasData): CanvasView {
  const progress = progressMap(data.progress);
  return {
    canvas: data.canvas,
    nodes: data.nodes.map((m) => toFlowNode(m, progress.get(m.id))),
    edges: data.edges.map(toFlowEdge),
  };
}

function deselect(v: CanvasView): CanvasView {
  if (!v.nodes.some((n) => n.selected) && !v.edges.some((e) => e.selected)) return v;
  return {
    ...v,
    nodes: v.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
    edges: v.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
  };
}

// --- отложенная запись (дебаунс) ---
const pendingMoves = new Map<string, Map<string, NodePosition>>();
const moveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingViewports = new Map<string, Viewport>();
const viewportTimers = new Map<string, ReturnType<typeof setTimeout>>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let initPromise: Promise<void> | null = null;
/**
 * Номер последней навигации (смена пространства, вход/выход из слоя) —
 * поздние ответы прежних навигаций игнорируются.
 */
let navSeq = 0;

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
      nodes: v.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, model: fn(n.data.model) } } : n,
      ),
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

  const topCanvas = (): string | undefined => {
    const { layers } = get();
    return layers[layers.length - 1];
  };

  /**
   * Бейдж прогресса задачи-владельца холста canvasId (ТЗ §4.3): пересчитывается
   * локально из загруженного холста после изменения задач в нём — живое
   * обновление, пока работаем в слое.
   */
  const refreshOwnerProgress = (canvasId: string) => {
    const s = get();
    const view = s.canvases[canvasId];
    const owner = view?.canvas.ownerNode;
    if (!view || !owner) return;
    const progress = progressOf(view.nodes);
    const canvases = { ...s.canvases };
    let changed = false;
    for (const [cid, v] of Object.entries(canvases)) {
      const i = v.nodes.findIndex((n) => n.id === owner);
      if (i < 0) continue;
      const n = v.nodes[i];
      const old = n.data.progress;
      if (old?.done === progress?.done && old?.total === progress?.total) continue;
      const nodes = [...v.nodes];
      const data = { ...n.data, progress };
      if (!progress) delete data.progress;
      nodes[i] = { ...n, data };
      canvases[cid] = { ...v, nodes };
      changed = true;
    }
    if (changed) set({ canvases });
  };

  const fetchSubtree = async (canvasId: string): Promise<SubtreeState | null> =>
    get().showNested
      ? { canvasId, levels: await api.loadSubtree(canvasId, SEE_THROUGH_MAX_DEPTH) }
      : null;

  /** Перечитать просвечивающие уровни верхнего холста (после удалений, переименований). */
  const refreshSubtree = async () => {
    const top = topCanvas();
    const seq = navSeq;
    if (!top) return;
    try {
      const subtree = await fetchSubtree(top);
      if (seq === navSeq && topCanvas() === top) set({ subtree });
    } catch (e) {
      get().showError(e);
    }
  };

  /**
   * Переход к стеку слоёв `target` (вход, выход, проваливание). Новые уровни
   * загружаются заново; уровни, уходящие под тинт, теряют выделение
   * (клавиатура работает только наверху). `select` — выделить ноду наверху.
   */
  const navigate = async (target: string[], select?: string) => {
    const seq = ++navSeq;
    const { layers, canvases } = get();
    try {
      const fresh: Record<string, CanvasView> = {};
      for (const cid of target) {
        if (!layers.includes(cid) || !canvases[cid]) {
          fresh[cid] = toView(await api.loadCanvas(cid));
        }
      }
      const top = target[target.length - 1];
      const subtree = await fetchSubtree(top);
      if (seq !== navSeq) return;
      set((s) => {
        const next = { ...s.canvases, ...fresh };
        for (const cid of target.slice(0, -1)) next[cid] = deselect(next[cid]);
        if (select) {
          const v = deselect(next[top]);
          next[top] = {
            ...v,
            nodes: v.nodes.map((n) => (n.id === select ? { ...n, selected: true } : n)),
          };
        }
        return { layers: target, canvases: next, subtree, editingNodeId: null };
      });
    } catch (e) {
      get().showError(e);
    }
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
    subtree: null,
    showNested: true,
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
          const showNested = (await api.getAppState(APP_STATE.showNested)) !== "0";
          const statusColors = parseStatusColors(await api.getAppState(APP_STATE.statusColors));
          set({ showNested, statusColors });
          const data = await api.loadCanvas(space.rootCanvas);
          const subtree = await fetchSubtree(space.rootCanvas);
          viewportBus.reset(data.canvas.viewport);
          set({
            phase: "ready",
            spaces,
            activeSpaceId: space.id,
            layers: [space.rootCanvas],
            canvases: { [space.rootCanvas]: toView(data) },
            subtree,
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
        if (kind === "task") {
          // Новая задача сразу открывается на редактирование заголовка (ТЗ §4.2).
          set({ editingNodeId: model.id });
          refreshOwnerProgress(canvasId);
        }
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
      if ("status" in patch) refreshOwnerProgress(canvasId);
      try {
        const fresh = await api.updateNode(id, patch);
        // Позиция живёт в FlowNode.position, поэтому x/y из ответа не мешают.
        setModel(canvasId, id, (m) => ({ ...fresh, x: m.x, y: m.y }));
        // Пути в тултипах просвечивающих нод содержат заголовки владельцев.
        if ("title" in patch && canvasId === topCanvas() && get().subtree?.levels.length) {
          void refreshSubtree();
        }
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
      // Направление — всегда как провели, в т.ч. «подзадача → родитель» (ТЗ §4.5):
      // межуровневую стрелку Rust принимает, если любой её конец — владелец холста.
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
      if (nodeIds.length) {
        refreshOwnerProgress(canvasId);
        // Вместе с задачами ушли их поддеревья — просвечивание перечитываем.
        if (canvasId === topCanvas()) void refreshSubtree();
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
      const seq = ++navSeq;
      // Отложенные перемещения/вьюпорт текущего пространства — в БД до загрузки нового.
      flushAll();
      try {
        const data = await api.loadCanvas(space.rootCanvas);
        const subtree = await fetchSubtree(space.rootCanvas);
        if (seq !== navSeq) return;
        // Все уровни монтируются заново — сразу с камерой нового пространства.
        viewportBus.reset(data.canvas.viewport);
        // Кэш холстов сбрасываем целиком: всё отложенное уже ушло в очередь записи.
        set({
          activeSpaceId: space.id,
          layers: [space.rootCanvas],
          canvases: { [space.rootCanvas]: toView(data) },
          subtree,
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

    enterLayer: async (nodeId) => {
      const top = topCanvas();
      const node = top ? get().canvases[top]?.nodes.find((n) => n.id === nodeId) : undefined;
      if (!node || node.data.model.kind !== "task") return;
      try {
        const child = await api.getOrCreateChildCanvas(nodeId);
        if (topCanvas() !== top) return; // пока ждали, ушли на другой уровень
        await navigate([...get().layers, child.id]);
      } catch (e) {
        get().showError(e);
      }
    },

    exitTo: async (index) => {
      const { layers } = get();
      if (index < 0 || index >= layers.length - 1) return;
      await navigate(layers.slice(0, index + 1));
    },

    diveTo: async (nodeId) => {
      const { layers, subtree, canvases } = get();
      const top = layers[layers.length - 1];
      if (!subtree || subtree.canvasId !== top) return;
      // На каком холсте лежит каждая нода (верхний + поддерево) и кто владелец каждого холста.
      const nodeCanvas = new Map<string, string>();
      canvases[top]?.nodes.forEach((n) => nodeCanvas.set(n.id, top));
      const owner = new Map<string, string>();
      for (const l of subtree.levels) {
        l.nodes.forEach((n) => nodeCanvas.set(n.id, l.canvas.id));
        if (l.canvas.ownerNode) owner.set(l.canvas.id, l.canvas.ownerNode);
      }
      const chain: string[] = [];
      let cid = nodeCanvas.get(nodeId);
      while (cid && cid !== top) {
        chain.unshift(cid);
        const o = owner.get(cid);
        cid = o ? nodeCanvas.get(o) : undefined;
      }
      if (cid !== top || chain.length === 0) return;
      await navigate([...layers, ...chain], nodeId);
    },

    setShowNested: async (show) => {
      set({ showNested: show, subtree: show ? get().subtree : null });
      if (show) await refreshSubtree();
      try {
        await api.setAppState(APP_STATE.showNested, show ? "1" : "0");
      } catch (e) {
        get().showError(e);
      }
    },

    showError: (e) => {
      const msg = errorMessage(e);
      console.error("[garlic]", msg);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ toast: null }), TOAST_MS);
      set({ toast: msg });
    },
    dismissToast: () => set({ toast: null }),

    statusColors: DEFAULT_STATUS_COLORS,

    setStatusColor: async (status, color) => {
      const statusColors = { ...get().statusColors, [status]: color };
      set({ statusColors });
      try {
        await api.setAppState(APP_STATE.statusColors, JSON.stringify(statusColors));
      } catch (e) {
        get().showError(e);
      }
    },

    setStatusMany: async (canvasId, ids, status) => {
      const view = get().canvases[canvasId];
      if (!view) return;
      const want = new Set(ids);
      const tasks = view.nodes
        .filter((n) => want.has(n.id) && n.data.model.kind === "task" && n.data.model.status !== status)
        .map((n) => n.id);
      if (!tasks.length) return;
      const changed = new Set(tasks);
      // Оптимистично, как updateNode.
      patchView(canvasId, (v) => ({
        ...v,
        nodes: v.nodes.map((n) =>
          changed.has(n.id) ? { ...n, data: { ...n.data, model: { ...n.data.model, status } } } : n,
        ),
      }));
      refreshOwnerProgress(canvasId);
      try {
        const fresh = new Map((await api.setStatusMany(tasks, status)).map((m) => [m.id, m]));
        patchView(canvasId, (v) => ({
          ...v,
          nodes: v.nodes.map((n) => {
            const m = fresh.get(n.id);
            return m ? { ...n, data: { ...n.data, model: { ...m, x: n.data.model.x, y: n.data.model.y } } } : n;
          }),
        }));
      } catch (e) {
        fail(canvasId, e);
      }
    },
  };
});

/** Цвета статусов из настроек (ТЗ §4.3, §4.6.2) — для всех, кто рисует задачи. */
export const useStatusColors = (): StatusColors => useGraph((s) => s.statusColors);
