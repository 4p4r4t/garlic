// Преобразование доменных моделей в объекты React Flow.

import { MarkerType, type Edge, type Node } from "@xyflow/react";

import type { EdgeModel, HandleSide, NodeKind, NodeModel, NodeProgress } from "../api";

export interface Progress {
  done: number;
  total: number;
}

export type NodeData = {
  model: NodeModel;
  /** Бейдж «выполнено/всего» (ТЗ §4.3) — только у задач с подзадачами. */
  progress?: Progress;
  /** Просвечивающая нода (ТЗ §4.5.1): глубина относительно текущего холста. */
  depth?: number;
  /** Путь для тултипа просвечивающей ноды: заголовки владельцев + её заголовок. */
  path?: string[];
};

/**
 * task / note — ноды текущего холста; anchor — нода-родитель слоя поверх тинта
 * (ТЗ §4.5); ghost — просвечивающая нода вложенного уровня (ТЗ §4.5.1).
 */
export type FlowNodeType = NodeKind | "anchor" | "ghost";
export type FlowNode = Node<NodeData, FlowNodeType>;
export type FlowEdge = Edge;

export const HANDLE_SIDES: readonly HandleSide[] = ["top", "right", "bottom", "left"];

export function isHandleSide(v: string | null | undefined): v is HandleSide {
  return v != null && (HANDLE_SIDES as readonly string[]).includes(v);
}

export function progressMap(list: NodeProgress[]): Map<string, Progress> {
  return new Map(list.map((p) => [p.nodeId, { done: p.done, total: p.total }]));
}

export function toFlowNode(m: NodeModel, progress?: Progress): FlowNode {
  return {
    id: m.id,
    type: m.kind,
    position: { x: m.x, y: m.y },
    data: progress ? { model: m, progress } : { model: m },
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

/** Прогресс по нодам холста (задачи). Пусто — undefined (бейдж не показывается). */
export function progressOf(nodes: FlowNode[]): Progress | undefined {
  let total = 0;
  let done = 0;
  for (const n of nodes) {
    if (n.data.model.kind !== "task") continue;
    total++;
    if (n.data.model.status === "done") done++;
  }
  return total > 0 ? { done, total } : undefined;
}
