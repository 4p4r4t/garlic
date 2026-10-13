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

import { api, type HandleSide, type NodeKind, type TaskStatus } from "../api";
import { useLayerExtras } from "../layers/extras";
import { AnchorNode, GhostNode } from "../layers/LayerNodes";
import { viewportBus } from "../layers/viewportBus";
import { useGraph } from "../store/graph";
import { useMode } from "../store/mode";
import { BulkBar } from "./BulkBar";
import { CanvasMenu } from "./CanvasMenu";
import { EDGE_COLOR, isHandleSide, type FlowEdge, type FlowNode } from "./flow";
import { GhostEdge } from "./GhostEdge";
import { CanvasHotkeys } from "./hotkeys";
import { NodeMenu } from "./NodeMenu";
import { NoteNode } from "./NoteNode";
import { TaskNode } from "./TaskNode";

const nodeTypes: NodeTypes = {
  task: TaskNode,
  note: NoteNode,
  anchor: AnchorNode,
  ghost: GhostNode,
};

const DELETE_KEYS = ["Delete", "Backspace"];
const MULTI_SELECT_KEYS = ["Shift", "Control", "Meta"];
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
 */
export function FlowCanvas({ canvasId, level, active, parentCanvasId, coveredNodeId }: Props) {
  const view = useGraph((s) => s.canvases[canvasId]);
  const onNodesChangeStore = useGraph((s) => s.onNodesChange);
  const onEdgesChangeStore = useGraph((s) => s.onEdgesChange);
  const createNode = useGraph((s) => s.createNode);
  const createConnectedNode = useGraph((s) => s.createConnectedNode);
  const updateNode = useGraph((s) => s.updateNode);
  const enterLayer = useGraph((s) => s.enterLayer);
  const exitTo = useGraph((s) => s.exitTo);
  const diveTo = useGraph((s) => s.diveTo);
  const queueMove = useGraph((s) => s.queueMove);
  const queueViewport = useGraph((s) => s.queueViewport);
  const connect = useGraph((s) => s.connect);
  const persistDelete = useGraph((s) => s.persistDelete);
  const startEditing = useGraph((s) => s.startEditing);
  const showError = useGraph((s) => s.showError);
  const setStatusMany = useGraph((s) => s.setStatusMany);

  const { screenToFlowPosition, deleteElements, setViewport } = useReactFlow<FlowNode, FlowEdge>();
  const rootRef = useRef<HTMLDivElement>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** Удаление уже подтверждено (групповая панель) — onBeforeDelete не спрашивает повторно. */
  const deleteConfirmed = useRef(false);
  /** Shift зажат — драг по пустому месту рисует рамку выделения (ТЗ §4.3, v1.2). */
  const selectKey = useKeyPress("Shift");
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeNodeMenu = useCallback(() => setNodeMenu(null), []);
  const closeMenus = useCallback(() => {
    setMenu(null);
    setNodeMenu(null);
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
    setTip(null);
  }, [active]);

  // Нода-родитель (якорь) и просвечивающие уровни — ноды не из этого холста.
  const extras = useLayerExtras(canvasId, parentCanvasId, active);

  const nodes = useMemo(() => {
    const own =
      coveredNodeId && !active
        ? view?.nodes.map((n) => (n.id === coveredNodeId ? { ...n, className: "is-covered" } : n))
        : view?.nodes;
    return extras.nodes.length ? [...extras.nodes, ...(own ?? [])] : (own ?? []);
  }, [view, extras.nodes, coveredNodeId, active]);

  const edges = useMemo(
    () => (extras.edges.length ? [...extras.edges, ...(view?.edges ?? [])] : (view?.edges ?? [])),
    [view, extras.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // Размеры особых нод запоминаем у себя, остальное — в стор холста.
      const own: NodeChange<FlowNode>[] = [];
      for (const c of changes) {
        if ("id" in c && extras.ids.has(c.id)) {
          if (c.type === "dimensions" && c.dimensions) extras.measured.set(c.id, c.dimensions);
        } else {
          own.push(c);
        }
      }
      if (own.length) onNodesChangeStore(canvasId, own);
    },
    [canvasId, onNodesChangeStore, extras],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      const own = changes.filter((c) => !("id" in c) || !extras.edgeIds.has(c.id));
      if (own.length) onEdgesChangeStore(canvasId, own);
    },
    [canvasId, onEdgesChangeStore, extras],
  );

  // --- контекстные меню ---
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      event.preventDefault();
      const screen = { x: event.clientX, y: event.clientY };
      setNodeMenu(null);
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
      // Нода-родитель слоя здесь не редактируется (её холст — уровнем ниже).
      if (node.type === "anchor") return;
      // Просвечивающая нода — «пустое место» текущего уровня.
      if (node.type === "ghost") {
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
  const menuNode = useMemo(
    () => (nodeMenu ? view?.nodes.find((n) => n.id === nodeMenu.nodeId) : undefined),
    [nodeMenu, view],
  );

  const onNodeColor = useCallback(
    (color: string | null) => {
      if (!menuNode) return;
      setNodeMenu(null);
      if (color !== menuNode.data.model.color) void updateNode(canvasId, menuNode.id, { color });
    },
    [canvasId, menuNode, updateNode],
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

  // --- клики и наведение на особые ноды ---
  const onPointerDownCapture = useCallback((e: ReactPointerEvent) => {
    downAt.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onNodeClick = useCallback(
    (event: ReactMouseEvent, node: FlowNode) => {
      // Пан, начатый на неперетаскиваемой ноде, тоже заканчивается click — это не клик.
      const d = downAt.current;
      if (d && Math.hypot(event.clientX - d.x, event.clientY - d.y) >= CLICK_SLOP) return;
      if (node.type === "anchor") {
        // Клик по ноде-родителю — выход из слоя (ТЗ §4.5).
        void exitTo(level - 1);
      } else if (node.type === "ghost") {
        // Клик по просвечивающей ноде — проваливание в её слой (ТЗ §4.5.1).
        setTip(null);
        void diveTo(node.id);
      }
    },
    [diveTo, exitTo, level],
  );

  const onNodeMouseEnter = useCallback((event: ReactMouseEvent, node: FlowNode) => {
    if (node.type !== "ghost" || !node.data.path) return;
    const el = event.currentTarget;
    if (!(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top, text: node.data.path.join(" › ") });
  }, []);
  const onNodeMouseLeave = useCallback(() => setTip(null), []);

  // --- перемещение и вьюпорт ---
  const savePositions = useCallback(
    (_: unknown, __: unknown, moved: FlowNode[]) =>
      queueMove(
        canvasId,
        moved.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      ),
    [canvasId, queueMove],
  );
  const saveSelectionPositions = useCallback(
    (_: unknown, moved: FlowNode[]) => savePositions(null, null, moved),
    [savePositions],
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
      c.source !== c.target && !extras.ghostIds.has(c.source) && !extras.ghostIds.has(c.target),
    [extras],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      void connect(canvasId, {
        source: c.source,
        target: c.target,
        sourceHandle: isHandleSide(c.sourceHandle) ? c.sourceHandle : null,
        targetHandle: isHandleSide(c.targetHandle) ? c.targetHandle : null,
      });
    },
    [canvasId, connect],
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
      // Просвечивающая нода — не цель стрелки, а пустое место текущего уровня.
      const el = hit?.closest<HTMLElement>(".react-flow__node:not(.react-flow__node-ghost)");
      if (el) {
        const targetId = el.dataset.id;
        if (!targetId || targetId === fromId) return;
        void connect(canvasId, {
          source: fromId,
          target: targetId,
          sourceHandle,
          targetHandle: nearestSide(el.getBoundingClientRect(), pt.x, pt.y),
        });
        return;
      }
      // Пустое место — только сам холст этого слоя (не топбар, не меню и т.п.).
      if (!hit || !rootRef.current?.contains(hit) || !state.from || !state.fromPosition) return;
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
    [canvasId, connect, screenToFlowPosition],
  );

  // --- удаление ---
  /** Подтверждение, если у удаляемых задач есть подзадачи (ТЗ §4.3). */
  const onBeforeDelete: OnBeforeDelete<FlowNode, FlowEdge> = useCallback(
    async ({ nodes: doomed }) => {
      if (deleteConfirmed.current) return true;
      try {
        let nested = 0;
        for (const n of doomed) {
          if (n.type === "task") nested += await api.countDescendants(n.id);
        }
        if (nested > 0) {
          return window.confirm(`Будут удалены и вложенные элементы (${nested}). Продолжить?`);
        }
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [showError],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
      void persistDelete(
        canvasId,
        gone.map((n) => n.id),
        cut.map((e) => e.id),
      );
    },
    [canvasId, persistDelete],
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
  const selectedNodes = useMemo(() => view?.nodes.filter((n) => n.selected) ?? [], [view]);
  const selectedTasks = selectedNodes.filter((n) => n.data.model.kind === "task").length;

  const onBulkStatus = useCallback(
    (status: TaskStatus) =>
      void setStatusMany(
        canvasId,
        selectedNodes.map((n) => n.id),
        status,
      ),
    [canvasId, selectedNodes, setStatusMany],
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
    const what = `Удалить выделенные ноды (${ids.length})`;
    const ok = window.confirm(
      nested > 0 ? `${what} вместе с вложенными элементами (${nested})?` : `${what}?`,
    );
    if (!ok) return;
    const edgeIds = view?.edges.filter((e) => e.selected).map((e) => ({ id: e.id })) ?? [];
    deleteConfirmed.current = true;
    try {
      await deleteElements({ nodes: ids.map((id) => ({ id })), edges: edgeIds });
    } finally {
      deleteConfirmed.current = false;
    }
  }, [deleteElements, selectedNodes, showError, view]);

  const connectionLineStyle = useMemo(() => ({ stroke: EDGE_COLOR, strokeWidth: 1.5 }), []);

  if (!view) return null;

  // Нижние уровни (под тинтом) — только картинка: без событий, клавиатуры и
  // обработчиков (обработчики, которые React Flow хранит в сторе, — NOOP, см. выше).
  const live = active;
  // В режиме «База» граф скрыт: клавиши React Flow (Delete, Shift, Space…)
  // слушают document и не должны срабатывать (ТЗ §4.10).
  const graphMode = useMode((s) => s.mode === "graph");
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
        selectionKeyCode={keys ? "Shift" : null}
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
        onPaneClick={live ? closeMenus : undefined}
        onNodeClick={live ? onNodeClick : undefined}
        onNodeMouseEnter={live ? onNodeMouseEnter : undefined}
        onNodeMouseLeave={live ? onNodeMouseLeave : undefined}
        onMoveStart={live ? onMoveStart : NOOP}
        onMove={live ? onMove : NOOP}
        onMoveEnd={live ? onMoveEnd : NOOP}
        onNodeDragStart={live ? closeMenus : NOOP}
        onNodeDragStop={live ? savePositions : NOOP}
        onSelectionDragStop={live ? saveSelectionPositions : NOOP}
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
          onDelete={onNodeDelete}
          onClose={closeNodeMenu}
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
