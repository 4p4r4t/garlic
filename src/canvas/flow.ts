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
  /** Сосед по уровню (ТЗ §4.12.4): подпись родителя (null — без родителя) и стек слоёв. */
  parentTitle?: string | null;
  chain?: string[];
  /** Рамка ничейного слоя / заглушка-якорь: id этого слоя и размер рамки. */
  layerId?: string;
  frame?: { w: number; h: number };
  /** Картинка стикера (просвечивание, соседи, якорь): задача, к которой он приклеен. */
  stickerHost?: string;
};

/**
 * task / note — ноды текущего холста; anchor — нода-родитель слоя поверх тинта
 * (ТЗ §4.5); ghost — просвечивающая нода вложенного уровня (ТЗ §4.5.1);
 * neighbor — нода соседнего холста того же уровня (ТЗ §4.12.4); orphanFrame —
 * пунктирная рамка просвечивающего ничейного слоя, orphanAnchor — заглушка
 * «Без родителя» вместо якоря в самом ничейном слое (ТЗ §4.12.3).
 */
export type FlowNodeType = NodeKind | "anchor" | "ghost" | "neighbor" | "orphanFrame" | "orphanAnchor";
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
  const n: FlowNode = {
    id: m.id,
    type: m.kind,
    position: { x: m.x, y: m.y },
    data: progress ? { model: m, progress } : { model: m },
  };
  // Стикер (ТЗ §4.12.7) — дочерняя нода React Flow своей задачи: x/y — смещение
  // от её угла, едет вместе с ней.
  if (m.stickerOf) {
    n.parentId = m.stickerOf;
    n.className = "is-sticker-node";
  }
  return n;
}

/** Стикеры — после своих задач (React Flow требует родителя раньше ребёнка). */
export function parentsFirst(nodes: FlowNode[]): FlowNode[] {
  if (!nodes.some((n) => n.parentId)) return nodes;
  const ids = new Set(nodes.map((n) => n.id));
  const out: FlowNode[] = [];
  const kids: FlowNode[] = [];
  for (const n of nodes) {
    if (!n.parentId) out.push(n);
    // Родителя нет среди нод (не должно случаться) — рисуем как есть, без привязки.
    else if (!ids.has(n.parentId)) out.push({ ...n, parentId: undefined });
    else kids.push(n);
  }
  return [...out, ...kids];
}

/** Цвет стрелки «блокирует» (ТЗ §4.12.7). */
export const BLOCK_EDGE_COLOR = "#d0675f";

export const EDGE_COLOR = "#7d8494";

export function toFlowEdge(e: EdgeModel): FlowEdge {
  if (e.kind === "blocks") {
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: "default",
      className: "edge-blocks",
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: BLOCK_EDGE_COLOR },
      label: "блокирует",
    };
  }
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
    // Стикеры — пометки задачи, а не подзадачи (ТЗ §4.12.7).
    if (n.data.model.kind !== "task" || n.data.model.stickerOf) continue;
    total++;
    if (n.data.model.status === "done") done++;
  }
  return total > 0 ? { done, total } : undefined;
}
