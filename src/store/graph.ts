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
  type DeleteMode,
  type HandleSide,
  type NeighborLevel,
  type NodeKind,
  type NodeModel,
  type NodePatch,
  type NodePlace,
  type NodePosition,
  type RegionChange,
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
import { rebase } from "../kb/paths";
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

/** В режиме подсветки верхний холст показывает вложенные уровни до этой глубины (ТЗ §4.12.1). */
export const HIGHLIGHT_MAX_DEPTH = 16;

/** Поддерево верхнего холста для просвечивания. */
export interface SubtreeState {
  canvasId: string;
  levels: SubtreeLevel[];
}

/** Соседи верхнего холста по уровню (ТЗ §4.12.4). */
export interface NeighborsState {
  canvasId: string;
  levels: NeighborLevel[];
}

/** «Выделено с подзадачами» (ТЗ §4.12.2): корни и все их вложенные ноды. */
export interface NestedSelection {
  roots: string[];
  places: NodePlace[];
  ids: Set<string>;
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

  // --- обзор задач (ТЗ §4.6.1) ---
  /**
   * Открыть цепочку слоёв `chain` (от корневого холста пространства до холста
   * ноды) и выделить ноду. В отличие от `diveTo`, нода может быть где угодно
   * в пространстве, а не только под верхним холстом.
   */
  revealNode: (chain: string[], nodeId: string) => Promise<void>;
  /**
   * Статус задачи с любого уровня пространства, в т.ч. с незагруженного холста.
   * `ownerId` — задача-владелец её холста (для бейджа прогресса), null — корень.
   */
  setTaskStatus: (
    canvasId: string,
    id: string,
    status: TaskStatus,
    ownerId: string | null,
  ) => Promise<void>;

  showError: (e: unknown) => void;
  dismissToast: () => void;

  // --- v1.2: групповые действия, цвета статусов ---
  /** Цвет заливки по статусу (настройки, app_state.status_colors). */
  statusColors: StatusColors;
  setStatusColor: (status: TaskStatus, color: string | null) => Promise<void>;
  /** Статус всем задачам из ids (заметки пропускаются) одним пакетом. */
  setStatusMany: (canvasId: string, ids: string[], status: TaskStatus) => Promise<void>;

  // --- ссылки на базу знаний (ТЗ §4.10, M5.2) ---
  /**
   * Путь `from` в vault стал `to` (переименование/перемещение — своё или снаружи;
   * в БД уже переписано): ссылки нод в кэше холстов переписываются так же,
   * заголовок ноды-заметки = имя её файла.
   */
  rewriteKbPaths: (from: string, to: string) => void;
  /** Перечитать просвечивающие уровни верхнего холста. */
  refreshSubtree: () => Promise<void>;
  /** Отправить отложенные записи (перемещения, вьюпорт) сразу — перед undo/redo (M6a). */
  flushWrites: () => void;
  /**
   * Перечитать холсты стека слоёв из БД поверх кэша (выделение и размеры нод
   * сохраняются), затем просвечивание/подсветку/соседей; исчезнувший слой —
   * закрыть. После undo/redo и перестроек дерева.
   */
  reloadOpen: () => Promise<void>;

  // --- M7a: слои и дерево (ТЗ §4.12) ---
  /** Последняя навигация по слоям: seamless — смена стека без анимаций (переход к соседу). */
  nav: { id: number; seamless: boolean };
  /** Режим подсветки (ТЗ §4.12.1, app_state.highlight_mode). */
  highlight: boolean;
  /**
   * Подсветка: вложенные холсты верхнего уровня (все глубины), загруженные в
   * кэш `canvases` и показанные на верхнем уровне как обычные ноды.
   */
  merged: string[];
  /** Подсветка: задача, выделенная кликом, — она и её поддерево обводятся. */
  hlRoot: string | null;
  setHighlight: (on: boolean) => Promise<void>;
  setHlRoot: (id: string | null) => void;
  /** Соседи верхнего холста по уровню. */
  neighbors: NeighborsState | null;
  /** Бесшовный переход к соседу по уровню: стек слоёв `chain`, нода выделяется. */
  switchToNeighbor: (chain: string[], nodeId: string) => Promise<void>;
  /** Проваливание в просвечивающий холст (например, ничейный слой в рамке). */
  diveToCanvas: (canvasId: string) => Promise<void>;
  /** «Всегда двигать задачу вместе с подзадачами» (app_state.move_with_subtasks). */
  moveWithSubtasks: boolean;
  setMoveWithSubtasks: (on: boolean) => Promise<void>;
  nested: NestedSelection | null;
  /** Выделить задачи `ids` вместе со всеми вложенными (Alt+клик, Alt+рамка, меню). */
  selectWithNested: (ids: string[], additive: boolean) => Promise<void>;
  clearNested: () => void;
  /** Положение нод на любых холстах — в кэш и просвечивание (запись — через queueMove). */
  placeNodes: (places: NodePlace[]) => void;
  /** Удаление задач с переносом подзадач на уровень выше / в ничейный слой. */
  deleteWith: (ids: string[], edgeIds: string[], mode: DeleteMode) => Promise<RegionChange | null>;
  /** «Перенести в задачу…». */
  moveIntoTask: (ids: string[], target: string) => Promise<RegionChange | null>;
}

/** Имя файла заметки без .md; не заметка — null. */
export function noteStem(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".md") && name.length > 3 ? name.slice(0, -3) : null;
}

function toView(data: CanvasData): CanvasView {
  const progress = progressMap(data.progress);
  return {
    canvas: data.canvas,
    nodes: data.nodes.map((m) => toFlowNode(m, progress.get(m.id))),
    edges: data.edges.map(toFlowEdge),
  };
}

/** Свежий холст из БД поверх кэша: выделение и размеры нод сохраняются (без мигания). */
export function mergeView(old: CanvasView | undefined, data: CanvasData): CanvasView {
  const progress = progressMap(data.progress);
  const oldNodes = new Map(old?.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map(old?.edges.map((e) => [e.id, e]));
  return {
    canvas: old ? { ...data.canvas, viewport: old.canvas.viewport } : data.canvas,
    nodes: data.nodes.map((m): FlowNode => {
      const fresh = toFlowNode(m, progress.get(m.id));
      const prev = oldNodes.get(m.id);
      return prev ? { ...prev, position: fresh.position, data: fresh.data } : fresh;
    }),
    edges: data.edges.map((e) => {
      const fresh = toFlowEdge(e);
      const prev = oldEdges.get(e.id);
      return prev?.selected ? { ...fresh, selected: true } : fresh;
    }),
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

  /** Всё «чужое» для верхнего холста: просвечивание или (подсветка) вложенные холсты, соседи. */
  interface Extras {
    subtree: SubtreeState | null;
    neighbors: NeighborsState | null;
    merged: SubtreeLevel[];
  }

  const fetchExtras = async (top: string, isRoot: boolean): Promise<Extras> => {
    const { highlight, showNested } = get();
    let subtree: SubtreeState | null = null;
    let merged: SubtreeLevel[] = [];
    if (highlight) merged = await api.loadSubtree(top, HIGHLIGHT_MAX_DEPTH);
    else if (showNested) {
      subtree = { canvasId: top, levels: await api.loadSubtree(top, SEE_THROUGH_MAX_DEPTH) };
    }
    const neighbors = isRoot ? null : { canvasId: top, levels: await api.loadLevelNeighbors(top) };
    return { subtree, neighbors, merged };
  };

  /** Применить Extras к состоянию: вложенные холсты подсветки — в кэш поверх старых. */
  const withExtras = (s: GraphState, canvases: Record<string, CanvasView>, ex: Extras) => {
    const next = { ...canvases };
    for (const l of ex.merged) next[l.canvas.id] = mergeView(s.canvases[l.canvas.id], l);
    return {
      canvases: next,
      subtree: ex.subtree,
      neighbors: ex.neighbors,
      merged: ex.merged.map((l) => l.canvas.id),
    };
  };

  /** Перечитать просвечивающие уровни / вложенные холсты подсветки / соседей верхнего холста. */
  const refreshSubtree = async () => {
    const top = topCanvas();
    const seq = navSeq;
    if (!top) return;
    try {
      const ex = await fetchExtras(top, get().layers.length === 1);
      if (seq === navSeq && topCanvas() === top) set((s) => withExtras(s, s.canvases, ex));
    } catch (e) {
      get().showError(e);
    }
  };

  /**
   * Переход к стеку слоёв `target` (вход, выход, проваливание). Новые уровни
   * загружаются заново; уровни, уходящие под тинт, теряют выделение
   * (клавиатура работает только наверху). `select` — выделить ноду наверху.
   * `seamless` — переход к соседу по уровню: уровни стека меняются на месте,
   * без анимаций тинта (ТЗ §4.12.4).
   */
  const navigate = async (target: string[], select?: string, seamless = false) => {
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
      const ex = await fetchExtras(top, target.length === 1);
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
        return {
          ...withExtras(s, next, ex),
          layers: target,
          editingNodeId: null,
          nav: { id: s.nav.id + 1, seamless },
          hlRoot: null,
          nested: null,
        };
      });
    } catch (e) {
      get().showError(e);
    }
  };

  /**
   * Цепочка холстов от верхнего до `canvasId` по просвечиванию или вложенным
   * холстам подсветки (без верхнего). null — холст не под верхним.
   */
  const chainBelowTop = (canvasId: string): string[] | null => {
    const { layers, subtree, canvases, merged } = get();
    const top = layers[layers.length - 1];
    const infos: { canvas: Canvas; nodeIds: string[] }[] =
      subtree && subtree.canvasId === top
        ? subtree.levels.map((l) => ({ canvas: l.canvas, nodeIds: l.nodes.map((n) => n.id) }))
        : merged
            .map((cid) => canvases[cid])
            .filter(Boolean)
            .map((v) => ({ canvas: v.canvas, nodeIds: v.nodes.map((n) => n.id) }));
    const nodeCanvas = new Map<string, string>();
    canvases[top]?.nodes.forEach((n) => nodeCanvas.set(n.id, top));
    const byId = new Map<string, Canvas>();
    for (const i of infos) {
      i.nodeIds.forEach((id) => nodeCanvas.set(id, i.canvas.id));
      byId.set(i.canvas.id, i.canvas);
    }
    const chain: string[] = [];
    let cid: string | undefined = canvasId;
    for (let guard = 0; cid && cid !== top && guard < 64; guard++) {
      const c = byId.get(cid);
      if (!c) return null;
      chain.unshift(cid);
      cid = c.ownerNode ? nodeCanvas.get(c.ownerNode) : (c.hostCanvas ?? undefined);
    }
    return cid === top && chain.length ? chain : null;
  };

  /** Перечитать уровни стека (после undo/redo и перестроек дерева). */
  const reloadOpen = async () => {
    const { layers } = get();
    const fresh: Record<string, CanvasData> = {};
    let gone = -1;
    for (let i = 0; i < layers.length; i++) {
      try {
        fresh[layers[i]] = await api.loadCanvas(layers[i]);
      } catch {
        gone = i;
        break;
      }
    }
    set((s) => {
      const canvases = { ...s.canvases };
      for (const [cid, data] of Object.entries(fresh)) canvases[cid] = mergeView(s.canvases[cid], data);
      // Остальные кэшированные холсты всё равно перечитываются при входе в слой;
      // вложенные холсты подсветки перечитает refreshSubtree.
      for (const cid of Object.keys(canvases)) {
        if (!s.layers.includes(cid) && !s.merged.includes(cid)) delete canvases[cid];
      }
      const editing = s.editingNodeId;
      const alive =
        editing && Object.values(canvases).some((v) => v.nodes.some((n) => n.id === editing));
      return { canvases, editingNodeId: alive ? editing : null };
    });
    if (gone > 0) await get().exitTo(gone - 1);
    else await refreshSubtree();
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
          const highlight = (await api.getAppState(APP_STATE.highlight)) === "1";
          const moveWithSubtasks = (await api.getAppState(APP_STATE.moveWithSubtasks)) === "1";
          const statusColors = parseStatusColors(await api.getAppState(APP_STATE.statusColors));
          set({ showNested, highlight, moveWithSubtasks, statusColors });
          const data = await api.loadCanvas(space.rootCanvas);
          const ex = await fetchExtras(space.rootCanvas, true);
          viewportBus.reset(data.canvas.viewport);
          set((s) => ({
            ...withExtras(s, { [space.rootCanvas]: toView(data) }, ex),
            phase: "ready",
            spaces,
            activeSpaceId: space.id,
            layers: [space.rootCanvas],
          }));
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
        // Новая нода сразу открывается на редактирование заголовка (ТЗ §4.2);
        // у заметки заголовок — имя её .md: переименование переименует файл.
        set({ editingNodeId: model.id });
        if (kind === "task") refreshOwnerProgress(canvasId);
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
      const before = get().canvases[canvasId]?.nodes.find((n) => n.id === id)?.data.model.kbPath;
      // Оптимистично: сразу в UI, при ошибке — перечитать холст.
      setModel(canvasId, id, (m) => ({ ...m, ...patch }));
      if ("status" in patch) refreshOwnerProgress(canvasId);
      try {
        const fresh = await api.updateNode(id, patch);
        // Позиция живёт в FlowNode.position, поэтому x/y из ответа не мешают.
        setModel(canvasId, id, (m) => ({ ...fresh, x: m.x, y: m.y }));
        // Заголовок ноды-заметки переименовал её файл — ссылки других нод тоже.
        if (!("kbPath" in patch) && before && fresh.kbPath && fresh.kbPath !== before) {
          get().rewriteKbPaths(before, fresh.kbPath);
        }
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
        if (canvasId === topCanvas() || get().merged.includes(canvasId)) void refreshSubtree();
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
        const ex = await fetchExtras(space.rootCanvas, true);
        if (seq !== navSeq) return;
        // Все уровни монтируются заново — сразу с камерой нового пространства.
        viewportBus.reset(data.canvas.viewport);
        // Кэш холстов сбрасываем целиком: всё отложенное уже ушло в очередь записи.
        set((s) => ({
          ...withExtras(s, { [space.rootCanvas]: toView(data) }, ex),
          activeSpaceId: space.id,
          layers: [space.rootCanvas],
          editingNodeId: null,
          nav: { id: s.nav.id + 1, seamless: false },
          hlRoot: null,
          nested: null,
        }));
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
      const { canvases, merged } = get();
      // Своя нода верхнего холста или (подсветка) нода вложенного холста.
      const home = [top, ...merged].find((cid) =>
        cid ? canvases[cid]?.nodes.some((n) => n.id === nodeId) : false,
      );
      const node = home ? canvases[home]?.nodes.find((n) => n.id === nodeId) : undefined;
      if (!home || !node || node.data.model.kind !== "task") return;
      const below = home === top ? [] : chainBelowTop(home);
      if (!below) return;
      try {
        const child = await api.getOrCreateChildCanvas(nodeId);
        if (topCanvas() !== top) return; // пока ждали, ушли на другой уровень
        await navigate([...get().layers, ...below, child.id]);
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
      const { layers, subtree } = get();
      const top = layers[layers.length - 1];
      if (!subtree || subtree.canvasId !== top) return;
      const level = subtree.levels.find((l) => l.nodes.some((n) => n.id === nodeId));
      const chain = level ? chainBelowTop(level.canvas.id) : null;
      if (!chain) return;
      await navigate([...layers, ...chain], nodeId);
    },

    diveToCanvas: async (canvasId) => {
      const chain = chainBelowTop(canvasId);
      if (chain) await navigate([...get().layers, ...chain]);
    },

    switchToNeighbor: async (chain, nodeId) => {
      const space = get().spaces.find((sp) => sp.id === get().activeSpaceId);
      if (!space || chain[0] !== space.rootCanvas) return;
      await navigate(chain, nodeId, true);
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

    revealNode: async (chain, nodeId) => {
      const space = get().spaces.find((sp) => sp.id === get().activeSpaceId);
      if (!space || chain[0] !== space.rootCanvas) return;
      await navigate(chain, nodeId);
    },

    setTaskStatus: async (canvasId, id, status, ownerId) => {
      if (get().canvases[canvasId]) {
        // Холст в кэше: оптимистично, с живым бейджем владельца.
        await get().updateNode(canvasId, id, { status });
      } else {
        try {
          await api.updateNode(id, { status });
        } catch (e) {
          get().showError(e);
          return;
        }
        // Бейдж владельца: его холст мог быть загружен — берём свежий прогресс.
        const holders = ownerId
          ? Object.entries(get().canvases)
              .filter(([, v]) => v.nodes.some((n) => n.id === ownerId))
              .map(([cid]) => cid)
          : [];
        for (const cid of holders) {
          try {
            const fresh = progressMap((await api.loadCanvas(cid)).progress);
            patchView(cid, (v) => ({
              ...v,
              nodes: v.nodes.map((n) => {
                if (n.id !== ownerId) return n;
                const data = { ...n.data, progress: fresh.get(n.id) };
                if (!data.progress) delete data.progress;
                return { ...n, data };
              }),
            }));
          } catch (e) {
            get().showError(e);
          }
        }
      }
      // Просвечивающие ноды показывают статус и бейджи — перечитываем.
      await refreshSubtree();
    },

    rewriteKbPaths: (from, to) => {
      if (!from || from === to) return;
      set((s) => {
        let changed = false;
        const canvases: Record<string, CanvasView> = {};
        for (const [cid, v] of Object.entries(s.canvases)) {
          let hit = false;
          const nodes = v.nodes.map((n) => {
            const m = n.data.model;
            // Обе роли задачи (ТЗ §4.11): «Комментарий» (kbPath) и «Результат».
            const next = m.kbPath ? (rebase(m.kbPath, from, to) ?? m.kbPath) : null;
            const result = m.kbResultPath ? (rebase(m.kbResultPath, from, to) ?? m.kbResultPath) : null;
            const title = m.kind === "note" && next ? (noteStem(next) ?? m.title) : m.title;
            if (next === m.kbPath && result === m.kbResultPath && title === m.title) return n;
            hit = true;
            return {
              ...n,
              data: { ...n.data, model: { ...m, kbPath: next, kbResultPath: result, title } },
            };
          });
          canvases[cid] = hit ? { ...v, nodes } : v;
          changed ||= hit;
        }
        return changed ? { canvases } : {};
      });
    },

    refreshSubtree,
    flushWrites: flushAll,
    reloadOpen,

    nav: { id: 0, seamless: false },
    highlight: false,
    merged: [],
    hlRoot: null,
    neighbors: null,
    moveWithSubtasks: false,
    nested: null,

    setHighlight: async (on) => {
      set({ highlight: on, hlRoot: null, nested: null, subtree: null, merged: on ? get().merged : [] });
      await refreshSubtree();
      try {
        await api.setAppState(APP_STATE.highlight, on ? "1" : "0");
      } catch (e) {
        get().showError(e);
      }
    },

    setHlRoot: (id) => set({ hlRoot: id }),

    setMoveWithSubtasks: async (on) => {
      set({ moveWithSubtasks: on });
      try {
        await api.setAppState(APP_STATE.moveWithSubtasks, on ? "1" : "0");
      } catch (e) {
        get().showError(e);
      }
    },

    selectWithNested: async (ids, additive) => {
      const seq = navSeq;
      const roots = new Set(ids);
      // Корни — выделить (на своих холстах; в подсветке это и вложенные холсты).
      const select = (want: (id: string) => boolean) =>
        set((s) => {
          const shown = new Set([...s.layers.slice(-1), ...s.merged]);
          const canvases = { ...s.canvases };
          for (const cid of shown) {
            const v = canvases[cid];
            if (!v) continue;
            canvases[cid] = {
              ...v,
              nodes: v.nodes.map((n) => {
                const on = want(n.id) || (additive && !!n.selected);
                return !!n.selected === on ? n : { ...n, selected: on };
              }),
            };
          }
          return { canvases };
        });
      select((id) => roots.has(id));
      let places: NodePlace[];
      try {
        places = await api.listDescendants(ids);
      } catch (e) {
        get().showError(e);
        return;
      }
      if (seq !== navSeq) return;
      const desc = new Set(places.map((p) => p.id));
      const prev = additive ? get().nested : null;
      const all = prev ? [...prev.places.filter((p) => !desc.has(p.id)), ...places] : places;
      // В подсветке вложенные ноды — обычные ноды верхнего уровня: выделяются
      // по-настоящему и перетаскиваются вместе с родителем силами React Flow.
      if (get().highlight) select((id) => roots.has(id) || desc.has(id));
      set({
        nested: {
          roots: [...new Set([...(prev?.roots ?? []), ...ids])],
          places: all,
          ids: new Set(all.map((p) => p.id)),
        },
      });
    },

    clearNested: () => set({ nested: null }),

    placeNodes: (places) => {
      if (!places.length) return;
      const at = new Map(places.map((p) => [p.id, p]));
      set((s) => {
        const canvases = { ...s.canvases };
        for (const [cid, v] of Object.entries(canvases)) {
          if (!v.nodes.some((n) => at.has(n.id))) continue;
          canvases[cid] = {
            ...v,
            nodes: v.nodes.map((n) => {
              const p = at.get(n.id);
              return p
                ? { ...n, position: { x: p.x, y: p.y }, data: { ...n.data, model: { ...n.data.model, x: p.x, y: p.y } } }
                : n;
            }),
          };
        }
        const subtree = s.subtree && {
          ...s.subtree,
          levels: s.subtree.levels.map((l) =>
            l.nodes.some((m) => at.has(m.id))
              ? { ...l, nodes: l.nodes.map((m) => (at.has(m.id) ? { ...m, x: at.get(m.id)!.x, y: at.get(m.id)!.y } : m)) }
              : l,
          ),
        };
        const nested = s.nested && {
          ...s.nested,
          places: s.nested.places.map((p) => at.get(p.id) ?? p),
        };
        return { canvases, subtree, nested };
      });
    },

    deleteWith: async (ids, edgeIds, mode) => {
      flushAll();
      if (ids.includes(get().editingNodeId ?? "")) set({ editingNodeId: null });
      try {
        const change = await api.deleteNodesWith(ids, edgeIds, mode);
        await reloadOpen();
        return change;
      } catch (e) {
        get().showError(e);
        await reloadOpen();
        return null;
      }
    },

    moveIntoTask: async (ids, target) => {
      flushAll();
      try {
        const change = await api.moveIntoTask(ids, target);
        await reloadOpen();
        return change;
      } catch (e) {
        get().showError(e);
        return null;
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
