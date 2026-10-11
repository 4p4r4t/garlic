// Преобразование доменных моделей в объекты React Flow.

import { MarkerType, type Edge, type Node } from "@xyflow/react";

import type { EdgeModel, HandleSide, NodeKind, NodeModel } from "../api";

export type NodeData = { model: NodeModel };
export type FlowNode = Node<NodeData, NodeKind>;
export type FlowEdge = Edge;

export const HANDLE_SIDES: readonly HandleSide[] = ["top", "right", "bottom", "left"];

export function isHandleSide(v: string | null | undefined): v is HandleSide {
  return v != null && (HANDLE_SIDES as readonly string[]).includes(v);
}

export function toFlowNode(m: NodeModel): FlowNode {
  return {
    id: m.id,
    type: m.kind,
    position: { x: m.x, y: m.y },
    data: { model: m },
  };
}

export const EDGE_COLOR = "#7d8494";

export function toFlowEdge(e: EdgeModel): FlowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: "default", // bezier
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: EDGE_COLOR },
    label: e.label ?? undefined,
  };
}
