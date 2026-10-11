import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
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
  type Viewport,
} from "@xyflow/react";

import { api, type HandleSide, type NodeKind } from "../api";
import { useGraph } from "../store/graph";
import { CanvasMenu } from "./CanvasMenu";
import { EDGE_COLOR, isHandleSide, type FlowEdge, type FlowNode } from "./flow";
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
}

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
  const queueMove = useGraph((s) => s.queueMove);
  const queueViewport = useGraph((s) => s.queueViewport);
  const connect = useGraph((s) => s.connect);
  const persistDelete = useGraph((s) => s.persistDelete);
  const startEditing = useGraph((s) => s.startEditing);
  const showError = useGraph((s) => s.showError);

  const { screenToFlowPosition } = useReactFlow<FlowNode, FlowEdge>();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);

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
      setMenu({ screen, flow: screenToFlowPosition(screen) });
    },
    [screenToFlowPosition],
  );

  /**
   * ПКМ по ноде. Браузерное меню подавлено; здесь M2 откроет
   * горизонтальную полосу иконок ноды (цвет / подзадачи / удалить, ТЗ §4.4).
   */
  const onNodeContextMenu = useCallback((event: ReactMouseEvent, _node: FlowNode) => {
    event.preventDefault();
    setMenu(null);
    // TODO(M2): openNodeMenu(_node.id, { x: event.clientX, y: event.clientY })
  }, []);

  const suppressContextMenu = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setMenu(null);
  }, []);

  const onPick = useCallback(
    (kind: NodeKind) => {
      if (!menu) return;
      setMenu(null);
      void createNode(canvasId, kind, menu.flow);
    },
    [canvasId, createNode, menu],
  );

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
    setMenu(null);
    setConnecting(true);
  }, []);

  /** Стрелку можно бросить не только на хэндл, но и на тело ноды. */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setConnecting(false);
      if (state.isValid) return; // уже обработано в onConnect
      const fromId = state.fromNode?.id;
      const pt = pointOf(event);
      if (!fromId || !pt) return;
      const el = document.elementFromPoint(pt.x, pt.y)?.closest<HTMLElement>(".react-flow__node");
      const targetId = el?.dataset.id;
      if (!el || !targetId || targetId === fromId) return;
      const fromHandle = state.fromHandle?.id;
      void connect(canvasId, {
        source: fromId,
        target: targetId,
        sourceHandle: isHandleSide(fromHandle) ? fromHandle : null,
        targetHandle: nearestSide(el.getBoundingClientRect(), pt.x, pt.y),
      });
    },
    [canvasId, connect],
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
    <div className={`canvas-root${connecting ? " is-connecting" : ""}`}>
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
        onPaneClick={closeMenu}
        onMoveStart={closeMenu}
        onMoveEnd={onMoveEnd}
        onNodeDragStart={closeMenu}
        onNodeDragStop={savePositions}
        onSelectionDragStop={saveSelectionPositions}
        onNodeDoubleClick={onNodeDoubleClick}
        onBeforeDelete={onBeforeDelete}
        onDelete={onDelete}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--grid-dot)" />
      </ReactFlow>
      {menu && (
        <CanvasMenu x={menu.screen.x} y={menu.screen.y} onPick={onPick} onClose={closeMenu} />
      )}
    </div>
  );
}
