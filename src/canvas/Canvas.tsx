import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  ReactFlow,
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

import { api, type HandleSide, type NodeKind } from "../api";
import { useGraph } from "../store/graph";
import { CanvasMenu } from "./CanvasMenu";
import { EDGE_COLOR, isHandleSide, type FlowEdge, type FlowNode } from "./flow";
import { GhostEdge } from "./GhostEdge";
import { NodeMenu } from "./NodeMenu";
import { NoteNode } from "./NoteNode";
import { TaskNode } from "./TaskNode";

const nodeTypes: NodeTypes = { task: TaskNode, note: NoteNode };

const DELETE_KEYS = ["Delete", "Backspace"];
const MULTI_SELECT_KEYS = ["Shift", "Control", "Meta"];
/** ЛКМ и средняя кнопка (колесо) панорамируют холст. */
const PAN_BUTTONS = [0, 1];

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

/** Ожидаемый размер новой ноды (min-width .g-node × одна строка) — для её размещения. */
const NEW_NODE_SIZE = { w: 150, h: 40 };

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
function placeBySide(at: XYPosition, side: HandleSide): XYPosition {
  const { w, h } = NEW_NODE_SIZE;
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

/** Один холст React Flow. Монтируется внутри ReactFlowProvider с key = canvasId. */
export function FlowCanvas({ canvasId }: { canvasId: string }) {
  const view = useGraph((s) => s.canvases[canvasId]);
  const onNodesChangeStore = useGraph((s) => s.onNodesChange);
  const onEdgesChangeStore = useGraph((s) => s.onEdgesChange);
  const createNode = useGraph((s) => s.createNode);
  const createConnectedNode = useGraph((s) => s.createConnectedNode);
  const updateNode = useGraph((s) => s.updateNode);
  const enterLayer = useGraph((s) => s.enterLayer);
  const queueMove = useGraph((s) => s.queueMove);
  const queueViewport = useGraph((s) => s.queueViewport);
  const connect = useGraph((s) => s.connect);
  const persistDelete = useGraph((s) => s.persistDelete);
  const startEditing = useGraph((s) => s.startEditing);
  const showError = useGraph((s) => s.showError);

  const { screenToFlowPosition, deleteElements } = useReactFlow<FlowNode, FlowEdge>();
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeNodeMenu = useCallback(() => setNodeMenu(null), []);
  const closeMenus = useCallback(() => {
    setMenu(null);
    setNodeMenu(null);
  }, []);

  // Вьюпорт берём один раз при монтировании холста: дальше им владеет React Flow.
  const [defaultViewport] = useState(() => view?.canvas.viewport);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => onNodesChangeStore(canvasId, changes),
    [canvasId, onNodesChangeStore],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => onEdgesChangeStore(canvasId, changes),
    [canvasId, onEdgesChangeStore],
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
  const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: FlowNode) => {
    event.preventDefault();
    setMenu(null);
    const el = event.currentTarget;
    if (!(el instanceof HTMLElement)) return;
    setNodeMenu({ nodeId: node.id, anchor: el.getBoundingClientRect() });
  }, []);

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
          placeBySide(menu.flow, from.side),
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
    enterLayer(menuNode.id);
  }, [enterLayer, menuNode]);

  /** Через React Flow — с тем же подтверждением и сохранением, что и клавиша Delete. */
  const onNodeDelete = useCallback(() => {
    if (!menuNode) return;
    setNodeMenu(null);
    void deleteElements({ nodes: [{ id: menuNode.id }] });
  }, [deleteElements, menuNode]);

  // --- перемещение и вьюпорт ---
  const savePositions = useCallback(
    (_: unknown, __: unknown, nodes: FlowNode[]) =>
      queueMove(
        canvasId,
        nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      ),
    [canvasId, queueMove],
  );
  const saveSelectionPositions = useCallback(
    (_: unknown, nodes: FlowNode[]) => savePositions(null, null, nodes),
    [savePositions],
  );
  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => queueViewport(canvasId, vp),
    [canvasId, queueViewport],
  );

  // --- стрелки ---
  const isValidConnection = useCallback(
    (c: Connection | Edge) => c.source !== c.target,
    [],
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
      const el = hit?.closest<HTMLElement>(".react-flow__node");
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
  /** Подтверждение, если у удаляемых задач есть подзадачи (появятся в M3). */
  const onBeforeDelete: OnBeforeDelete<FlowNode, FlowEdge> = useCallback(
    async ({ nodes }) => {
      try {
        let nested = 0;
        for (const n of nodes) {
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
    ({ nodes, edges }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
      void persistDelete(
        canvasId,
        nodes.map((n) => n.id),
        edges.map((e) => e.id),
      );
    },
    [canvasId, persistDelete],
  );

  const onNodeDoubleClick = useCallback(
    // M5: у заметки двойной клик откроет редактор Markdown; пока — заголовок.
    (_: ReactMouseEvent, node: FlowNode) => startEditing(node.id),
    [startEditing],
  );

  const connectionLineStyle = useMemo(() => ({ stroke: EDGE_COLOR, strokeWidth: 1.5 }), []);

  if (!view) return null;

  return (
    <div ref={rootRef} className={`canvas-root${connecting ? " is-connecting" : ""}`}>
      <ReactFlow<FlowNode, FlowEdge>
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        defaultViewport={defaultViewport}
        minZoom={0.1}
        maxZoom={4}
        colorMode="dark"
        connectionMode={ConnectionMode.Loose}
        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={connectionLineStyle}
        isValidConnection={isValidConnection}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        deleteKeyCode={DELETE_KEYS}
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        panOnDrag={PAN_BUTTONS}
        zoomOnDoubleClick={false}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={suppressContextMenu}
        onSelectionContextMenu={suppressContextMenu}
        onPaneClick={closeMenus}
        onMoveStart={closeMenus}
        onMoveEnd={onMoveEnd}
        onNodeDragStart={closeMenus}
        onNodeDragStop={savePositions}
        onSelectionDragStop={saveSelectionPositions}
        onNodeDoubleClick={onNodeDoubleClick}
        onBeforeDelete={onBeforeDelete}
        onDelete={onDelete}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--grid-dot)" />
        {menu?.from && (
          <GhostEdge
            from={menu.from.point}
            fromPosition={menu.from.position}
            to={menu.flow}
            toSide={menu.from.side}
          />
        )}
      </ReactFlow>
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
    </div>
  );
}
