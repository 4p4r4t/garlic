import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  ReactFlow,
  useKeyPress,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type NodeTypes,
  type OnBeforeDelete,
  type Position,
  type Viewport,
  type XYPosition,
} from "@xyflow/react";
import { FolderInput } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { api, type HandleSide, type NodeKind, type NodePlace, type NodePosition, type TaskStatus } from "../api";
import { orphanFrame, useLayerExtras } from "../layers/extras";
import {
  AnchorNode,
  GhostNode,
  NeighborNode,
  OrphanAnchorNode,
  OrphanFrameNode,
} from "../layers/LayerNodes";
import { viewportBus } from "../layers/viewportBus";
import { useGraph, type CanvasView } from "../store/graph";
import { grouped, groupSync, noteOrigin } from "../store/history";
import { useMode } from "../store/mode";
import { BulkBar } from "./BulkBar";
import { CanvasMenu } from "./CanvasMenu";
import { EDGE_COLOR, isHandleSide, type FlowEdge, type FlowNode } from "./flow";
import { GhostEdge } from "./GhostEdge";
import { CanvasHotkeys } from "./hotkeys";
import { NodeMenu } from "./NodeMenu";
import { NoteNode } from "./NoteNode";
import { PopupMenu } from "./PopupMenu";
import { TaskNode } from "./TaskNode";
import { useTreeDialogs } from "./TreeDialogs";

const nodeTypes: NodeTypes = {
  task: TaskNode,
  note: NoteNode,
  anchor: AnchorNode,
  ghost: GhostNode,
  neighbor: NeighborNode,
  orphanFrame: OrphanFrameNode,
  orphanAnchor: OrphanAnchorNode,
};

const DELETE_KEYS = ["Delete", "Backspace"];
const MULTI_SELECT_KEYS = ["Shift", "Control", "Meta"];
/** Shift — рамка выделения (ТЗ §4.3), Alt — рамка «с подзадачами» (ТЗ §4.12.2). */
const SELECTION_KEYS = ["Shift", "Alt"];
/** ЛКМ и средняя кнопка (колесо) панорамируют холст. */
const PAN_BUTTONS = [0, 1];
/** Клик, а не пан: указатель сместился меньше чем на столько (px). */
const CLICK_SLOP = 4;
const HIDE_ATTRIBUTION = { hideAttribution: true };
/**
 * Заглушка вместо обработчика на нижних уровнях. Не undefined: React Flow
 * (StoreUpdater) пропускает undefined и оставил бы прежний обработчик — уровень,
 * ушедший под тинт, продолжал бы, например, рассылать камеру из onMove.
 */
const NOOP = () => {};
const DENY_DELETE = async () => false;
const NO_VIEWS: CanvasView[] = [];
/** Ноды, на которые нельзя бросить стрелку (и которые не «пустое место» для меню). */
const NOT_TARGET =
  ".react-flow__node:not(.react-flow__node-ghost):not(.react-flow__node-neighbor):not(.react-flow__node-orphanFrame):not(.react-flow__node-orphanAnchor)";

interface MenuState {
  /** экранные координаты — для позиционирования меню */
  screen: { x: number; y: number };
  /** координаты холста — куда ставить ноду */
  flow: { x: number; y: number };
  /** Меню открыто отпусканием стрелки в пустом месте (ТЗ §4.2.1): откуда она тянется. */
  from?: PendingSource;
}

interface PendingSource {
  nodeId: string;
  handle: HandleSide | null;
  /** центр исходного хэндла (координаты холста) и его сторона — для призрачной стрелки */
  point: XYPosition;
  position: Position;
  /** сторона новой ноды, обращённая к источнику */
  side: HandleSide;
}

interface NodeMenuState {
  nodeId: string;
  /** экранный прямоугольник ноды на момент открытия */
  anchor: DOMRect;
}

interface HoverTip {
  /** экранная точка: середина верхнего края ноды */
  x: number;
  y: number;
  text: string;
}

/** Подзадачи, которые едут вместе с перетаскиваемой задачей (ТЗ §4.12.2). */
interface Follow {
  /** Нода, за которой следим (её смещение — смещение всех). */
  ref: string;
  start: XYPosition;
  /** Исходные положения подзадач; null — ещё грузятся. */
  places: NodePlace[] | null;
  pending: Promise<NodePlace[]> | null;
}

/**
 * Размер новой ноды — для её размещения у конца стрелки. Заметка — .g-node
 * 240 × min 90 (ТЗ §4.3); задача выше: название + «Комментарий» + «Результат»
 * + низ (ТЗ §4.11, однострочное название).
 */
const NEW_NODE_SIZE: Record<NodeKind, { w: number; h: number }> = {
  task: { w: 240, h: 112 },
  note: { w: 240, h: 90 },
};

/** Ближайшая к точке сторона прямоугольника — для стрелки, брошенной на тело ноды. */
function nearestSide(rect: DOMRect, x: number, y: number): HandleSide {
  const d: [HandleSide, number][] = [
    ["top", Math.abs(y - rect.top)],
    ["right", Math.abs(rect.right - x)],
    ["bottom", Math.abs(rect.bottom - y)],
    ["left", Math.abs(x - rect.left)],
  ];
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/** Сторона новой ноды в точке `at`, обращённая к источнику `from`. */
function sideToward(at: XYPosition, from: XYPosition): HandleSide {
  const dx = from.x - at.x;
  const dy = from.y - at.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

/** Левый верхний угол новой ноды — так, чтобы середина стороны `side` пришлась на `at`. */
function placeBySide(at: XYPosition, side: HandleSide, kind: NodeKind): XYPosition {
  const { w, h } = NEW_NODE_SIZE[kind];
  switch (side) {
    case "left":
      return { x: at.x, y: at.y - h / 2 };
    case "right":
      return { x: at.x - w, y: at.y - h / 2 };
    case "top":
      return { x: at.x - w / 2, y: at.y };
    case "bottom":
      return { x: at.x - w / 2, y: at.y - h };
  }
}

function pointOf(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ("changedTouches" in event) {
    const t = event.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

const isReal = (n: FlowNode) => n.type === "task" || n.type === "note";

/** Ноды по холстам: { canvasId → items }. */
function byCanvas<T>(items: T[], canvasOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of items) {
    const c = canvasOf(t);
    const list = out.get(c);
    if (list) list.push(t);
    else out.set(c, [t]);
  }
  return out;
}

interface Props {
  canvasId: string;
  /** Индекс в стеке слоёв (0 — корневой холст пространства). */
  level: number;
  /** Верхний уровень: интерактивный, ведёт камеру, показывает просвечивание. */
  active: boolean;
  /** Холст уровнем ниже (там лежит нода-родитель этого слоя). */
  parentCanvasId?: string;
  /** Нода этого холста, над которой открыт следующий слой (там она рисуется якорем). */
  coveredNodeId?: string;
}

/**
 * Один уровень стека слоёв (ТЗ §4.5) — свой экземпляр React Flow внутри своего
 * ReactFlowProvider. Верхний уровень полностью интерактивен; нижние лежат под
 * тинтом без событий и только повторяют общую камеру (viewportBus). Экземпляр
 * не пересоздаётся при смене роли — уходящий под тинт уровень не мигает.
 *
 * Режим подсветки (ТЗ §4.12.1): верхний уровень показывает, кроме своих нод,
 * ноды всех вложенных холстов как обычные редактируемые ноды; каждое действие
 * уходит в холст самой ноды (`model.canvasId`).
 */
export function FlowCanvas({ canvasId, level, active, parentCanvasId, coveredNodeId }: Props) {
  const view = useGraph((s) => s.canvases[canvasId]);
  const highlight = useGraph((s) => s.highlight);
  const mergedViews = useGraph(
    useShallow((s) =>
      active && s.highlight && s.merged.length
        ? s.merged.map((cid) => s.canvases[cid]).filter((v): v is CanvasView => !!v)
        : NO_VIEWS,
    ),
  );
  const hlRoot = useGraph((s) => (active && s.highlight ? s.hlRoot : null));
  const nested = useGraph((s) => (active ? s.nested : null));
  const onNodesChangeStore = useGraph((s) => s.onNodesChange);
  const onEdgesChangeStore = useGraph((s) => s.onEdgesChange);
  const createNode = useGraph((s) => s.createNode);
  const createConnectedNode = useGraph((s) => s.createConnectedNode);
  const updateNode = useGraph((s) => s.updateNode);
  const enterLayer = useGraph((s) => s.enterLayer);
  const exitTo = useGraph((s) => s.exitTo);
  const diveTo = useGraph((s) => s.diveTo);
  const diveToCanvas = useGraph((s) => s.diveToCanvas);
  const switchToNeighbor = useGraph((s) => s.switchToNeighbor);
  const queueMove = useGraph((s) => s.queueMove);
  const queueViewport = useGraph((s) => s.queueViewport);
  const connect = useGraph((s) => s.connect);
  const persistDelete = useGraph((s) => s.persistDelete);
  const deleteWith = useGraph((s) => s.deleteWith);
  const startEditing = useGraph((s) => s.startEditing);
  const showError = useGraph((s) => s.showError);
  const setStatusMany = useGraph((s) => s.setStatusMany);
  const selectWithNested = useGraph((s) => s.selectWithNested);
  const clearNested = useGraph((s) => s.clearNested);
  const setHlRoot = useGraph((s) => s.setHlRoot);
  const placeNodes = useGraph((s) => s.placeNodes);

  const { screenToFlowPosition, deleteElements, setViewport } = useReactFlow<FlowNode, FlowEdge>();
  const rootRef = useRef<HTMLDivElement>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [orphanMenu, setOrphanMenu] = useState<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** Удаление уже подтверждено (групповая панель) — onBeforeDelete не спрашивает повторно. */
  const deleteConfirmed = useRef(false);
  /** Shift/Alt зажат — драг по пустому месту рисует рамку выделения (ТЗ §4.3, §4.12.2). */
  const selectKey = useKeyPress(SELECTION_KEYS);
  const follow = useRef<Follow | null>(null);
  const [followIds, setFollowIds] = useState<Set<string> | null>(null);
  const [followDelta, setFollowDelta] = useState<XYPosition | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeNodeMenu = useCallback(() => setNodeMenu(null), []);
  const closeOrphanMenu = useCallback(() => setOrphanMenu(null), []);
  const closeMenus = useCallback(() => {
    setMenu(null);
    setNodeMenu(null);
    setOrphanMenu(null);
  }, []);

  // Камера одна на пространство (ТЗ §1): уровень монтируется с текущей
  // камерой, дальше её ведёт верхний уровень.
  const [defaultViewport] = useState(() => viewportBus.get());

  // Нижние уровни повторяют камеру верхнего каждый кадр пана/зума.
  useEffect(() => {
    if (active) return;
    void setViewport(viewportBus.get());
    return viewportBus.subscribe((vp) => void setViewport(vp));
  }, [active, setViewport]);

  // Уходя под тинт, уровень закрывает свои меню и тултип.
  useEffect(() => {
    if (active) return;
    setMenu(null);
    setNodeMenu(null);
    setOrphanMenu(null);
    setTip(null);
  }, [active]);

  // Нода-родитель (якорь), просвечивающие уровни, соседи — ноды не из этого холста.
  const extras = useLayerExtras(canvasId, parentCanvasId, active);

  /** Холст каждой «настоящей» ноды верхнего уровня (свои + вложенные в подсветке). */
  const nodeCanvas = useMemo(() => {
    const m = new Map<string, string>();
    view?.nodes.forEach((n) => m.set(n.id, canvasId));
    for (const v of mergedViews) v.nodes.forEach((n) => m.set(n.id, v.canvas.id));
    return m;
  }, [view, mergedViews, canvasId]);
  const edgeCanvas = useMemo(() => {
    const m = new Map<string, string>();
    view?.edges.forEach((e) => m.set(e.id, canvasId));
    for (const v of mergedViews) v.edges.forEach((e) => m.set(e.id, v.canvas.id));
    return m;
  }, [view, mergedViews, canvasId]);
  const canvasOf = useCallback((id: string) => nodeCanvas.get(id) ?? canvasId, [nodeCanvas, canvasId]);

  /** Подсветка: задача, выделенная кликом, и всё её поддерево (по загруженным холстам). */
  const hlIds = useMemo(() => {
    if (!hlRoot) return null;
    const byOwner = new Map<string, CanvasView>();
    const byHost = new Map<string, CanvasView[]>();
    for (const v of mergedViews) {
      if (v.canvas.ownerNode) byOwner.set(v.canvas.ownerNode, v);
      else if (v.canvas.hostCanvas) {
        byHost.set(v.canvas.hostCanvas, [...(byHost.get(v.canvas.hostCanvas) ?? []), v]);
      }
    }
    const out = new Set<string>([hlRoot]);
    const visitCanvas = (v: CanvasView, guard: number) => {
      if (guard > 64) return;
      for (const n of v.nodes) {
        out.add(n.id);
        const c = byOwner.get(n.id);
        if (c) visitCanvas(c, guard + 1);
      }
      for (const h of byHost.get(v.canvas.id) ?? []) visitCanvas(h, guard + 1);
    };
    const own = byOwner.get(hlRoot);
    if (own) visitCanvas(own, 0);
    return out;
  }, [hlRoot, mergedViews]);

  /** Рамки ничейных слоёв среди вложенных холстов подсветки. */
  const mergedFrames = useMemo(() => {
    const frames: FlowNode[] = [];
    for (const v of mergedViews) {
      if (v.canvas.ownerNode || !v.canvas.hostCanvas) continue;
      const f = orphanFrame(
        v.canvas.id,
        v.nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
        (id) => v.nodes.find((n) => n.id === id)?.measured as { width: number; height: number } | undefined,
        -1,
      );
      if (f) frames.push(f);
    }
    return frames;
  }, [mergedViews]);

  const nodes = useMemo(() => {
    let own =
      coveredNodeId && !active
        ? view?.nodes.map((n) => (n.id === coveredNodeId ? { ...n, className: "is-covered" } : n))
        : view?.nodes;
    let merged = mergedViews.length ? mergedViews.flatMap((v) => v.nodes) : [];
    let extra = extras.nodes;
    if (hlIds) {
      const mark = (n: FlowNode) => (hlIds.has(n.id) ? { ...n, className: "is-hl" } : n);
      own = own?.map(mark);
      merged = merged.map(mark);
    }
    // Подзадачи едут за перетаскиваемой задачей (ТЗ §4.12.2).
    if (followIds && followDelta) {
      const shift = (n: FlowNode) =>
        followIds.has(n.id)
          ? { ...n, position: { x: n.position.x + followDelta.x, y: n.position.y + followDelta.y } }
          : n;
      merged = merged.map(shift);
      extra = extra.map(shift);
    }
    const all = [...extra, ...mergedFrames, ...merged, ...(own ?? [])];
    return all;
  }, [view, extras.nodes, coveredNodeId, active, mergedViews, mergedFrames, hlIds, followIds, followDelta]);

  const edges = useMemo(() => {
    const merged = mergedViews.length ? mergedViews.flatMap((v) => v.edges) : [];
    if (!extras.edges.length && !merged.length) return view?.edges ?? [];
    return [...extras.edges, ...merged, ...(view?.edges ?? [])];
  }, [view, extras.edges, mergedViews]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // Размеры особых нод запоминаем у себя, остальное — в стор холста самой ноды.
      const own: NodeChange<FlowNode>[] = [];
      const other = new Map<string, NodeChange<FlowNode>[]>();
      for (const c of changes) {
        if ("id" in c && extras.ids.has(c.id)) {
          if (c.type === "dimensions" && c.dimensions) extras.measured.set(c.id, c.dimensions);
          continue;
        }
        if ("id" in c && c.id.startsWith("orphan-frame:")) continue;
        const cid = "id" in c ? canvasOf(c.id) : canvasId;
        if (cid === canvasId) own.push(c);
        else other.set(cid, [...(other.get(cid) ?? []), c]);
      }
      if (own.length) onNodesChangeStore(canvasId, own);
      for (const [cid, list] of other) onNodesChangeStore(cid, list);
    },
    [canvasId, onNodesChangeStore, extras, canvasOf],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      const groups = new Map<string, EdgeChange<FlowEdge>[]>();
      for (const c of changes) {
        if ("id" in c && extras.edgeIds.has(c.id)) continue;
        const cid = ("id" in c && edgeCanvas.get(c.id)) || canvasId;
        groups.set(cid, [...(groups.get(cid) ?? []), c]);
      }
      for (const [cid, list] of groups) onEdgesChangeStore(cid, list);
    },
    [canvasId, onEdgesChangeStore, extras, edgeCanvas],
  );

  /**
   * Холст, где хранится стрелка source → target: общий холст концов либо
   * вложенный холст, у которого один конец — владелец (ТЗ §6). null — нельзя.
   */
  const edgeHome = useCallback(
    (source: string, target: string): string | null => {
      const g = useGraph.getState();
      const anchorId = g.canvases[canvasId]?.canvas.ownerNode;
      const where = (id: string) => (id === anchorId ? parentCanvasId : nodeCanvas.get(id));
      const cs = where(source);
      const ct = where(target);
      if (!cs || !ct) return null;
      if (cs === ct) return cs;
      if (g.canvases[ct]?.canvas.ownerNode === source) return ct;
      if (g.canvases[cs]?.canvas.ownerNode === target) return cs;
      return null;
    },
    [canvasId, parentCanvasId, nodeCanvas],
  );

  // --- контекстные меню ---
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      event.preventDefault();
      const screen = { x: event.clientX, y: event.clientY };
      setNodeMenu(null);
      setOrphanMenu(null);
      setMenu({ screen, flow: screenToFlowPosition(screen) });
    },
    [screenToFlowPosition],
  );

  /** ПКМ по ноде — полоса иконок ноды: цвет / подзадачи / удалить (ТЗ §4.4). */
  const onNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: FlowNode) => {
      event.preventDefault();
      setMenu(null);
      setNodeMenu(null);
      setOrphanMenu(null);
      // Нода-родитель слоя здесь не редактируется (её холст — уровнем ниже).
      if (node.type === "anchor") return;
      // Заглушка ничейного слоя: «Перенести в задачу…» для всего слоя (ТЗ §4.12.3).
      if (node.type === "orphanAnchor") {
        setOrphanMenu({ x: event.clientX, y: event.clientY });
        return;
      }
      // Просвечивающая нода, сосед, рамка — «пустое место» текущего уровня.
      if (!isReal(node)) {
        onPaneContextMenu(event);
        return;
      }
      const el = event.currentTarget;
      if (!(el instanceof HTMLElement)) return;
      setNodeMenu({ nodeId: node.id, anchor: el.getBoundingClientRect() });
    },
    [onPaneContextMenu],
  );

  const suppressContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      closeMenus();
    },
    [closeMenus],
  );

  const onPick = useCallback(
    (kind: NodeKind) => {
      if (!menu) return;
      setMenu(null);
      const { from } = menu;
      if (from) {
        void createConnectedNode(
          canvasId,
          kind,
          placeBySide(menu.flow, from.side, kind),
          { nodeId: from.nodeId, handle: from.handle },
          from.side,
        );
      } else {
        void createNode(canvasId, kind, menu.flow);
      }
    },
    [canvasId, createConnectedNode, createNode, menu],
  );

  // --- меню ноды ---
  const menuNode = useMemo(() => {
    if (!nodeMenu) return undefined;
    const find = (v: CanvasView | undefined) => v?.nodes.find((n) => n.id === nodeMenu.nodeId);
    return find(view) ?? mergedViews.map(find).find(Boolean);
  }, [nodeMenu, view, mergedViews]);

  const onNodeColor = useCallback(
    (color: string | null) => {
      if (!menuNode) return;
      setNodeMenu(null);
      const m = menuNode.data.model;
      if (color !== m.color) void updateNode(m.canvasId, menuNode.id, { color });
    },
    [menuNode, updateNode],
  );

  const onNodeSubtasks = useCallback(() => {
    if (!menuNode) return;
    setNodeMenu(null);
    void enterLayer(menuNode.id);
  }, [enterLayer, menuNode]);

  /** Через React Flow — с тем же подтверждением и сохранением, что и клавиша Delete. */
  const onNodeDelete = useCallback(() => {
    if (!menuNode) return;
    setNodeMenu(null);
    void deleteElements({ nodes: [{ id: menuNode.id }] });
  }, [deleteElements, menuNode]);

  const onNodeSelectNested = useCallback(() => {
    if (!menuNode) return;
    setNodeMenu(null);
    void selectWithNested([menuNode.id], false);
  }, [menuNode, selectWithNested]);

  /** Выделенные ноды верхнего уровня (свои и, в подсветке, вложенные). */
  const selectedNodes = useMemo(() => {
    const own = view?.nodes.filter((n) => n.selected) ?? [];
    const merged = mergedViews.flatMap((v) => v.nodes.filter((n) => n.selected));
    return merged.length ? [...own, ...merged] : own;
  }, [view, mergedViews]);
  const selectedTasks = selectedNodes.filter((n) => n.data.model.kind === "task").length;

  /** «Перенести в задачу…»: нода из меню, а если она выделена — всё выделенное. */
  const onNodeMoveTo = useCallback(() => {
    if (!menuNode) return;
    setNodeMenu(null);
    const ids = menuNode.selected ? selectedNodes.map((n) => n.id) : [menuNode.id];
    const what =
      ids.length === 1 ? `«${menuNode.data.model.title || "Без названия"}»` : `выделенное (${ids.length})`;
    useTreeDialogs.getState().openMove(ids, what);
  }, [menuNode, selectedNodes]);

  /** Заглушка ничейного слоя → «Перенести в задачу…» — весь слой. */
  const onOrphanMoveTo = useCallback(() => {
    const ids = view?.nodes.map((n) => n.id) ?? [];
    if (ids.length) useTreeDialogs.getState().openMove(ids, `весь слой (${ids.length})`);
  }, [view]);

  // --- клики и наведение на особые ноды ---
  const onPointerDownCapture = useCallback((e: ReactPointerEvent) => {
    downAt.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onNodeClick = useCallback(
    (event: ReactMouseEvent, node: FlowNode) => {
      // Пан, начатый на неперетаскиваемой ноде, тоже заканчивается click — это не клик.
      const d = downAt.current;
      if (d && Math.hypot(event.clientX - d.x, event.clientY - d.y) >= CLICK_SLOP) return;
      switch (node.type) {
        case "anchor":
        case "orphanAnchor":
          // Клик по ноде-родителю (или заглушке) — выход из слоя (ТЗ §4.5).
          void exitTo(level - 1);
          return;
        case "ghost":
          // Клик по просвечивающей ноде — проваливание в её слой (ТЗ §4.5.1).
          setTip(null);
          void diveTo(node.id);
          return;
        case "orphanFrame":
          if (node.data.layerId) void diveToCanvas(node.data.layerId);
          return;
        case "neighbor":
          // Сосед по уровню — бесшовный переход в слой его родителя (ТЗ §4.12.4).
          setTip(null);
          if (node.data.chain) void switchToNeighbor(node.data.chain, node.id);
          return;
      }
      // Alt+клик — выделить задачу вместе с подзадачами (ТЗ §4.12.2).
      if (event.altKey && node.data.model.kind === "task") {
        void selectWithNested([node.id], event.shiftKey || event.ctrlKey || event.metaKey);
      }
      // Подсветка: клик обводит задачу и всё её поддерево (ТЗ §4.12.1).
      if (highlight) setHlRoot(node.id);
    },
    [diveTo, diveToCanvas, exitTo, level, switchToNeighbor, selectWithNested, highlight, setHlRoot],
  );

  const onPaneClick = useCallback(() => {
    closeMenus();
    if (highlight) setHlRoot(null);
  }, [closeMenus, highlight, setHlRoot]);

  const onNodeMouseEnter = useCallback((event: ReactMouseEvent, node: FlowNode) => {
    if (node.type !== "ghost" || !node.data.path) return;
    const el = event.currentTarget;
    if (!(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top, text: node.data.path.join(" › ") });
  }, []);
  const onNodeMouseLeave = useCallback(() => setTip(null), []);

  // Выделение «с подзадачами» живёт, пока выделены его корни.
  useEffect(() => {
    if (!nested) return;
    const sel = new Set(selectedNodes.map((n) => n.id));
    if (!nested.roots.every((r) => sel.has(r))) clearNested();
  }, [nested, selectedNodes, clearNested]);

  // --- перемещение и вьюпорт ---
  /** Начало драга: какие подзадачи поедут следом (Alt-выделение или настройка). */
  const beginFollow = useCallback((ref: FlowNode, dragged: FlowNode[]) => {
    follow.current = null;
    setFollowIds(null);
    setFollowDelta(null);
    const g = useGraph.getState();
    const draggedIds = new Set(dragged.map((n) => n.id));
    const nestedRoots = g.nested?.roots ?? [];
    const roots = dragged
      .filter(
        (n) => n.data.model.kind === "task" && (g.moveWithSubtasks || nestedRoots.includes(n.id)),
      )
      .map((n) => n.id);
    if (!roots.length) return;
    const st: Follow = { ref: ref.id, start: { ...ref.position }, places: null, pending: null };
    follow.current = st;
    const accept = (places: NodePlace[]) => {
      // Ноды, которые и так едут силами React Flow (выделенные), — не трогаем.
      const list = places.filter((p) => !draggedIds.has(p.id));
      if (follow.current === st) {
        st.places = list;
        setFollowIds(new Set(list.map((p) => p.id)));
      }
      return list;
    };
    if (g.nested && roots.every((r) => nestedRoots.includes(r))) accept(g.nested.places);
    else st.pending = api.listDescendants(roots).then(accept, () => []);
  }, []);

  const trackFollow = useCallback((nodes: FlowNode[]) => {
    const st = follow.current;
    if (!st) return;
    const ref = nodes.find((n) => n.id === st.ref);
    if (ref) setFollowDelta({ x: ref.position.x - st.start.x, y: ref.position.y - st.start.y });
  }, []);

  /** Конец драга: свои и вложенные ноды — по их холстам, одним шагом undo. */
  const savePositions = useCallback(
    async (moved: FlowNode[]) => {
      const st = follow.current;
      follow.current = null;
      let followers: NodePlace[] = [];
      if (st) {
        const places = st.places ?? (st.pending ? await st.pending : []);
        const ref = moved.find((n) => n.id === st.ref);
        const dx = ref ? ref.position.x - st.start.x : 0;
        const dy = ref ? ref.position.y - st.start.y : 0;
        if (dx || dy) {
          for (const p of places) noteOrigin(p.id, p);
          followers = places.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
        }
      }
      const real = moved.filter(isReal);
      const groups = byCanvas<NodePlace>(
        [...real.map((n) => ({ id: n.id, canvasId: canvasOf(n.id), x: n.position.x, y: n.position.y })), ...followers],
        (p) => p.canvasId,
      );
      const total = real.length + followers.length;
      groupSync(total === 1 ? "перемещение" : `перемещение ${total} нод`, () => {
        for (const [cid, list] of groups) {
          queueMove(cid, list.map((p): NodePosition => ({ id: p.id, x: p.x, y: p.y })));
        }
      });
      placeNodes(followers);
      setFollowIds(null);
      setFollowDelta(null);
    },
    [canvasOf, queueMove, placeNodes],
  );

  const onNodeDragStart = useCallback(
    (_: unknown, node: FlowNode, dragged: FlowNode[]) => {
      closeMenus();
      beginFollow(node, dragged);
    },
    [closeMenus, beginFollow],
  );
  const onNodeDrag = useCallback(
    (_: unknown, __: FlowNode, dragged: FlowNode[]) => trackFollow(dragged),
    [trackFollow],
  );
  const onNodeDragStop = useCallback(
    (_: unknown, __: FlowNode, moved: FlowNode[]) => void savePositions(moved),
    [savePositions],
  );
  const onSelectionDragStart = useCallback(
    (_: unknown, dragged: FlowNode[]) => {
      closeMenus();
      if (dragged[0]) beginFollow(dragged[0], dragged);
    },
    [closeMenus, beginFollow],
  );
  const onSelectionDrag = useCallback(
    (_: unknown, dragged: FlowNode[]) => trackFollow(dragged),
    [trackFollow],
  );
  const onSelectionDragStop = useCallback(
    (_: unknown, moved: FlowNode[]) => void savePositions(moved),
    [savePositions],
  );

  /** Alt+рамка — выделенные рамкой задачи вместе с подзадачами (ТЗ §4.12.2). */
  const onSelectionEnd = useCallback(
    (event: ReactMouseEvent) => {
      if (!event.altKey) return;
      // Выделение рамкой применяется в том же цикле — читаем после него.
      setTimeout(() => {
        const g = useGraph.getState();
        const views = [g.canvases[canvasId], ...(g.highlight ? g.merged.map((c) => g.canvases[c]) : [])];
        const ids = views
          .flatMap((v) => v?.nodes ?? [])
          .filter((n) => n.selected && n.data.model.kind === "task")
          .map((n) => n.id);
        if (ids.length) void selectWithNested(ids, true);
      }, 0);
    },
    [canvasId, selectWithNested],
  );

  const onMoveStart = useCallback(() => {
    closeMenus();
    setTip(null);
  }, [closeMenus]);
  /** Каждый кадр пана/зума — нижним уровням. */
  const onMove = useCallback((_: unknown, vp: Viewport) => viewportBus.emit(vp), []);
  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => queueViewport(canvasId, vp),
    [canvasId, queueViewport],
  );

  // --- стрелки ---
  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      c.source !== c.target &&
      !extras.ghostIds.has(c.source) &&
      !extras.ghostIds.has(c.target) &&
      (!highlight || edgeHome(c.source, c.target) !== null),
    [extras, highlight, edgeHome],
  );

  const connectEnds = useCallback(
    (ends: Parameters<typeof connect>[1]) => {
      const home = highlight ? edgeHome(ends.source, ends.target) : canvasId;
      if (home) void connect(home, ends);
    },
    [highlight, edgeHome, canvasId, connect],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      connectEnds({
        source: c.source,
        target: c.target,
        sourceHandle: isHandleSide(c.sourceHandle) ? c.sourceHandle : null,
        targetHandle: isHandleSide(c.targetHandle) ? c.targetHandle : null,
      });
    },
    [connectEnds],
  );

  const onConnectStart = useCallback(() => {
    closeMenus();
    setTip(null);
    setConnecting(true);
  }, [closeMenus]);

  /**
   * Стрелку можно бросить не только на хэндл, но и на тело ноды. Брошенная
   * в пустое место — открывает меню «Задача / Заметка» для соединённой ноды (§4.2.1).
   */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setConnecting(false);
      if (state.isValid) return; // уже обработано в onConnect
      const fromId = state.fromNode?.id;
      const pt = pointOf(event);
      if (!fromId || !pt) return;
      const fromHandle = state.fromHandle?.id;
      const sourceHandle = isHandleSide(fromHandle) ? fromHandle : null;
      const hit = document.elementFromPoint(pt.x, pt.y);
      // Просвечивающая нода, сосед, рамка — не цель стрелки, а пустое место текущего уровня.
      const el = hit?.closest<HTMLElement>(NOT_TARGET);
      if (el) {
        const targetId = el.dataset.id;
        if (!targetId || targetId === fromId) return;
        connectEnds({
          source: fromId,
          target: targetId,
          sourceHandle,
          targetHandle: nearestSide(el.getBoundingClientRect(), pt.x, pt.y),
        });
        return;
      }
      // Пустое место — только сам холст этого слоя (не топбар, не меню и т.п.).
      if (!hit || !rootRef.current?.contains(hit) || !state.from || !state.fromPosition) return;
      // Стрелка в пустое место из вложенной ноды подсветки создала бы ноду не
      // на её холсте — не предлагаем.
      if (nodeCanvas.has(fromId) && canvasOf(fromId) !== canvasId) return;
      const flow = screenToFlowPosition(pt);
      setMenu({
        screen: pt,
        flow,
        from: {
          nodeId: fromId,
          handle: sourceHandle,
          point: state.from,
          position: state.fromPosition,
          side: sideToward(flow, state.from),
        },
      });
    },
    [connectEnds, screenToFlowPosition, nodeCanvas, canvasOf, canvasId],
  );

  // --- удаление ---
  /**
   * Задача с подзадачами (ТЗ §4.12.3): выбор «Удалить подзадачи / Перенести на
   * уровень родителя / Не трогать» и отдельное подтверждение. Перенос и
   * «не трогать» выполняет Rust одной командой — тогда React Flow ничего не удаляет.
   */
  const onBeforeDelete: OnBeforeDelete<FlowNode, FlowEdge> = useCallback(
    async ({ nodes: doomed, edges: cut }) => {
      if (deleteConfirmed.current) return true;
      const dialogs = useTreeDialogs.getState();
      if (dialogs.deleteAsk) return false;
      const real = doomed.filter(isReal);
      try {
        let nested = 0;
        const parents: string[] = [];
        for (const n of real) {
          if (n.data.model.kind !== "task") continue;
          const k = await api.countDescendants(n.id);
          if (k > 0) {
            nested += k;
            parents.push(n.data.model.title);
          }
        }
        if (nested === 0) return true;
        const choice = await dialogs.askDelete({ titles: parents, count: real.length, nested });
        if (!choice) return false;
        if (choice === "delete") return true;
        await deleteWith(
          real.map((n) => n.id),
          cut.map((e) => e.id),
          choice,
        );
        return false;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [showError, deleteWith],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
      const groups = new Map<string, { nodes: string[]; edges: string[] }>();
      const at = (cid: string) => {
        let g = groups.get(cid);
        if (!g) groups.set(cid, (g = { nodes: [], edges: [] }));
        return g;
      };
      gone.filter(isReal).forEach((n) => at(canvasOf(n.id)).nodes.push(n.id));
      cut.forEach((e) => at(edgeCanvas.get(e.id) ?? canvasId).edges.push(e.id));
      const run = async () => {
        for (const [cid, g] of groups) await persistDelete(cid, g.nodes, g.edges);
      };
      if (groups.size <= 1) void run();
      else void grouped(`удаление ${gone.length} нод`, run);
    },
    [canvasId, canvasOf, edgeCanvas, persistDelete],
  );

  const onNodeDoubleClick = useCallback(
    // Двойной клик по заголовку — переименование; по остальной карточке
    // ноды-заметки — открыть её .md в режиме «База» (ТЗ §4.10).
    (event: ReactMouseEvent, node: FlowNode) => {
      if (node.type === "task") startEditing(node.id);
      if (node.type !== "note") return;
      const onTitle = (event.target as HTMLElement).closest?.(".node-title");
      const path = node.data.model.kbPath;
      if (!onTitle && path) useMode.getState().openInKb({ kind: "open", path });
      else startEditing(node.id);
    },
    [startEditing],
  );

  // --- групповые действия (ТЗ §4.3, v1.2) ---
  const onBulkStatus = useCallback(
    (status: TaskStatus) => {
      const groups = byCanvas(selectedNodes, (n) => canvasOf(n.id));
      const run = async () => {
        for (const [cid, list] of groups) {
          await setStatusMany(
            cid,
            list.map((n) => n.id),
            status,
          );
        }
      };
      if (groups.size <= 1) void run();
      else void grouped(`статус ${selectedTasks} задач`, run);
    },
    [selectedNodes, setStatusMany, canvasOf, selectedTasks],
  );

  /** Одно подтверждение на всё (с числом вложенных элементов), дальше — как Delete. */
  const onBulkDelete = useCallback(async () => {
    const ids = selectedNodes.map((n) => n.id);
    if (!ids.length) return;
    let nested = 0;
    try {
      for (const n of selectedNodes) {
        if (n.type === "task") nested += await api.countDescendants(n.id);
      }
    } catch (e) {
      showError(e);
      return;
    }
    const edgeIds = [
      ...(view?.edges ?? []),
      ...mergedViews.flatMap((v) => v.edges),
    ]
      .filter((e) => e.selected)
      .map((e) => ({ id: e.id }));
    // С подзадачами — окно выбора их судьбы (ТЗ §4.12.3) спросит onBeforeDelete.
    if (nested > 0) {
      await deleteElements({ nodes: ids.map((id) => ({ id })), edges: edgeIds });
      return;
    }
    if (!window.confirm(`Удалить выделенные ноды (${ids.length})?`)) return;
    deleteConfirmed.current = true;
    try {
      await deleteElements({ nodes: ids.map((id) => ({ id })), edges: edgeIds });
    } finally {
      deleteConfirmed.current = false;
    }
  }, [deleteElements, selectedNodes, showError, view, mergedViews]);

  const connectionLineStyle = useMemo(() => ({ stroke: EDGE_COLOR, strokeWidth: 1.5 }), []);

  // В режиме «База» граф скрыт: клавиши React Flow (Delete, Shift, Space…)
  // слушают document и не должны срабатывать (ТЗ §4.10).
  const graphMode = useMode((s) => s.mode === "graph");

  if (!view) return null;

  // Нижние уровни (под тинтом) — только картинка: без событий, клавиатуры и
  // обработчиков (обработчики, которые React Flow хранит в сторе, — NOOP, см. выше).
  const live = active;
  const keys = live && graphMode;
  return (
    <div
      ref={rootRef}
      className={`canvas-root${connecting ? " is-connecting" : ""}${live && selectKey ? " is-select-key" : ""}`}
      onPointerDownCapture={live ? onPointerDownCapture : undefined}
    >
      <ReactFlow<FlowNode, FlowEdge>
        className={level > 0 ? "is-layer" : undefined}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        defaultViewport={defaultViewport}
        minZoom={0.1}
        maxZoom={4}
        colorMode="dark"
        proOptions={level > 0 ? HIDE_ATTRIBUTION : undefined}
        connectionMode={ConnectionMode.Loose}
        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={connectionLineStyle}
        isValidConnection={isValidConnection}
        nodesDraggable={live}
        nodesConnectable={live}
        nodesFocusable={live}
        edgesFocusable={live}
        elementsSelectable={live}
        panOnDrag={live ? PAN_BUTTONS : false}
        zoomOnScroll={live}
        zoomOnPinch={live}
        preventScrolling={live}
        disableKeyboardA11y={!keys}
        deleteKeyCode={keys ? DELETE_KEYS : null}
        multiSelectionKeyCode={keys ? MULTI_SELECT_KEYS : null}
        selectionKeyCode={keys ? SELECTION_KEYS : null}
        panActivationKeyCode={keys ? "Space" : null}
        zoomActivationKeyCode={keys ? "Control" : null}
        zoomOnDoubleClick={false}
        onConnect={live ? onConnect : NOOP}
        onConnectStart={live ? onConnectStart : NOOP}
        onConnectEnd={live ? onConnectEnd : NOOP}
        onPaneContextMenu={live ? onPaneContextMenu : undefined}
        onNodeContextMenu={live ? onNodeContextMenu : undefined}
        onEdgeContextMenu={live ? suppressContextMenu : undefined}
        onSelectionContextMenu={live ? suppressContextMenu : undefined}
        onPaneClick={live ? onPaneClick : undefined}
        onNodeClick={live ? onNodeClick : undefined}
        onNodeMouseEnter={live ? onNodeMouseEnter : undefined}
        onNodeMouseLeave={live ? onNodeMouseLeave : undefined}
        onMoveStart={live ? onMoveStart : NOOP}
        onMove={live ? onMove : NOOP}
        onMoveEnd={live ? onMoveEnd : NOOP}
        onNodeDragStart={live ? onNodeDragStart : NOOP}
        onNodeDrag={live ? onNodeDrag : NOOP}
        onNodeDragStop={live ? onNodeDragStop : NOOP}
        onSelectionDragStart={live ? onSelectionDragStart : NOOP}
        onSelectionDrag={live ? onSelectionDrag : NOOP}
        onSelectionDragStop={live ? onSelectionDragStop : NOOP}
        onSelectionEnd={live ? onSelectionEnd : NOOP}
        onNodeDoubleClick={live ? onNodeDoubleClick : undefined}
        onBeforeDelete={live ? onBeforeDelete : DENY_DELETE}
        onDelete={live ? onDelete : NOOP}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.3}
          color={level > 0 ? "var(--grid-dot-layer)" : "var(--grid-dot)"}
        />
        {menu?.from && (
          <GhostEdge
            from={menu.from.point}
            fromPosition={menu.from.position}
            to={menu.flow}
            toSide={menu.from.side}
          />
        )}
      </ReactFlow>
      {keys && <CanvasHotkeys canvasId={canvasId} root={rootRef} />}
      {menu && (
        <CanvasMenu x={menu.screen.x} y={menu.screen.y} onPick={onPick} onClose={closeMenu} />
      )}
      {nodeMenu && menuNode && (
        <NodeMenu
          model={menuNode.data.model}
          anchor={nodeMenu.anchor}
          onColor={onNodeColor}
          onSubtasks={onNodeSubtasks}
          onSelectNested={onNodeSelectNested}
          onMoveTo={onNodeMoveTo}
          onDelete={onNodeDelete}
          onClose={closeNodeMenu}
        />
      )}
      {orphanMenu && (
        <PopupMenu
          x={orphanMenu.x}
          y={orphanMenu.y}
          items={[
            {
              label: "Перенести в задачу…",
              icon: <FolderInput size={14} />,
              onClick: onOrphanMoveTo,
            },
          ]}
          onClose={closeOrphanMenu}
        />
      )}
      {live && selectedNodes.length >= 2 && (
        <BulkBar
          count={selectedNodes.length}
          tasks={selectedTasks}
          onStatus={onBulkStatus}
          onDelete={() => void onBulkDelete()}
        />
      )}
      {tip && (
        <div className="ghost-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tip.text}
        </div>
      )}
    </div>
  );
}
