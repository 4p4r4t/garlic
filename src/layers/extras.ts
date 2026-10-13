// «Чужие» ноды уровня стека слоёв:
// - якорь (anchor) — нода-родитель слоя поверх тинта, на своём месте (ТЗ §4.5);
//   у ничейного слоя вместо него — заглушка «Без родителя» (orphanAnchor, ТЗ §4.12.3);
// - просвечивающие ноды и стрелки вложенных уровней (ghost, ТЗ §4.5.1), у
//   ничейных слоёв — в пунктирной рамке «без родителя» (orphanFrame);
// - соседи по уровню (neighbor, ТЗ §4.12.4): ноды других холстов той же глубины.
//
// React Flow держит размеры нод в `measured`; объекты этих нод собираются
// здесь заново при изменении данных, поэтому размеры запоминаются отдельно
// и подставляются — иначе нода на кадр пропадала бы до перемера.

import { useMemo, useRef } from "react";

import type { NodeModel } from "../api";
import { progressMap, progressOf, toFlowEdge, type FlowEdge, type FlowNode } from "../canvas/flow";
import { useGraph } from "../store/graph";

/** Непрозрачность просвечивающих уровней: +1, +2, +3 и глубже (ТЗ §4.5.1). Зеркало — styles.css. */
export const GHOST_OPACITY = [0.55, 0.3, 0.15] as const;

/** z-index: текущий уровень — 0, якорь — над ним, соседи и вложенные — ниже, глубже — ещё ниже. */
const ghostNodeZ = (depth: number) => -10 * depth;
const ghostEdgeZ = (depth: number) => -10 * depth - 5;
const NEIGHBOR_NODE_Z = -2;
const NEIGHBOR_EDGE_Z = -3;

/** Размер ноды до перемера (как у новой задачи, ТЗ §4.3). */
const DEFAULT_SIZE = { width: 240, height: 112 };
/** Поля рамки ничейного слоя вокруг его нод; сверху — место под подпись. */
const FRAME_PAD = 18;
const FRAME_CAPTION = 26;
/** Заглушка «Без родителя» — над нодами ничейного слоя. */
const ORPHAN_ANCHOR_GAP = 150;

export const ORPHAN_FRAME_PREFIX = "orphan-frame:";
export const ORPHAN_ANCHOR_PREFIX = "orphan-anchor:";

export interface LayerExtras {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** id всех особых нод (якорь, просвечивающие, соседи, рамки). */
  ids: Set<string>;
  edgeIds: Set<string>;
  /** Ноды, на которые нельзя бросить стрелку (всё, кроме якоря). */
  ghostIds: Set<string>;
  /** Запомненные размеры особых нод. */
  measured: Map<string, { width: number; height: number }>;
}

const EMPTY: FlowNode[] = [];
const EMPTY_EDGES: FlowEdge[] = [];

/** Модель-заглушка для служебных нод (рамка, заглушка якоря): React Flow нужен data.model. */
export function stubModel(id: string, canvasId: string): NodeModel {
  return {
    id,
    canvasId,
    kind: "task",
    title: "",
    body: "",
    status: null,
    color: null,
    x: 0,
    y: 0,
    width: null,
    height: null,
    kbPath: null,
    kbResultPath: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

type Sized = { id: string; x: number; y: number };

/** Прямоугольник, охватывающий ноды (по их измеренным размерам или размеру по умолчанию). */
export function boundsOf(
  nodes: Sized[],
  sizeOf: (id: string) => { width: number; height: number } | undefined,
): { x: number; y: number; w: number; h: number } | null {
  if (!nodes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    const s = sizeOf(n.id) ?? DEFAULT_SIZE;
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + s.width);
    y1 = Math.max(y1, n.y + s.height);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Пунктирная рамка «без родителя» вокруг нод ничейного слоя (ТЗ §4.12.3). */
export function orphanFrame(
  layerId: string,
  nodes: Sized[],
  sizeOf: (id: string) => { width: number; height: number } | undefined,
  zIndex: number,
  className?: string,
): FlowNode | null {
  const b = boundsOf(nodes, sizeOf);
  if (!b) return null;
  const id = ORPHAN_FRAME_PREFIX + layerId;
  const w = b.w + FRAME_PAD * 2;
  const h = b.h + FRAME_PAD * 2 + FRAME_CAPTION;
  return {
    id,
    type: "orphanFrame",
    position: { x: b.x - FRAME_PAD, y: b.y - FRAME_PAD - FRAME_CAPTION },
    data: { model: stubModel(id, layerId), layerId, frame: { w, h } },
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
    focusable: false,
    zIndex,
    className,
    measured: { width: w, height: h },
  };
}

export function useLayerExtras(
  canvasId: string,
  parentCanvasId: string | undefined,
  active: boolean,
): LayerExtras {
  const measured = useRef(new Map<string, { width: number; height: number }>()).current;

  const ownerId = useGraph((s) => s.canvases[canvasId]?.canvas.ownerNode ?? null);
  const isOrphan = useGraph((s) => {
    const c = s.canvases[canvasId]?.canvas;
    return !!c && !c.ownerNode && !!c.hostCanvas;
  });
  const ownerNode = useGraph((s) =>
    parentCanvasId && ownerId
      ? s.canvases[parentCanvasId]?.nodes.find((n) => n.id === ownerId)
      : undefined,
  );
  const ownNodes = useGraph((s) => s.canvases[canvasId]?.nodes);
  const subtree = useGraph((s) =>
    active && s.subtree?.canvasId === canvasId ? s.subtree : null,
  );
  const neighbors = useGraph((s) =>
    active && s.neighbors?.canvasId === canvasId ? s.neighbors : null,
  );
  const nestedIds = useGraph((s) => (active ? s.nested?.ids : undefined));

  // Живой прогресс родителя — из задач этого слоя.
  const progress = useMemo(() => progressOf(ownNodes ?? []), [ownNodes]);
  const done = progress?.done;
  const total = progress?.total;

  const anchor = useMemo<FlowNode | null>(() => {
    if (!ownerNode) return null;
    return {
      id: ownerNode.id,
      type: "anchor",
      position: ownerNode.position,
      data: {
        model: ownerNode.data.model,
        progress: total ? { done: done ?? 0, total } : undefined,
      },
      draggable: false,
      selectable: false,
      deletable: false,
      focusable: false,
      // Хэндлы якоря — начало стрелок «родитель → подзадача» (только наверху).
      connectable: active,
      zIndex: 1,
      measured: measured.get(ownerNode.id) ?? ownerNode.measured,
    };
  }, [ownerNode, done, total, active, measured]);

  // Ничейный слой: заглушка «Без родителя» над его нодами (ТЗ §4.12.3).
  const orphanBounds = useMemo(() => {
    if (!isOrphan || !ownNodes?.length) return null;
    return boundsOf(
      ownNodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      (id) => ownNodes.find((n) => n.id === id)?.measured as { width: number; height: number } | undefined,
    );
  }, [isOrphan, ownNodes]);
  const orphanX = orphanBounds?.x;
  const orphanY = orphanBounds?.y;
  const orphanAnchor = useMemo<FlowNode | null>(() => {
    if (!isOrphan) return null;
    const id = ORPHAN_ANCHOR_PREFIX + canvasId;
    return {
      id,
      type: "orphanAnchor",
      position: { x: orphanX ?? 0, y: (orphanY ?? 0) - ORPHAN_ANCHOR_GAP },
      data: { model: stubModel(id, canvasId), layerId: canvasId },
      draggable: false,
      selectable: false,
      deletable: false,
      connectable: false,
      focusable: false,
      zIndex: 1,
      measured: measured.get(id),
    };
  }, [isOrphan, canvasId, orphanX, orphanY, measured]);

  const ghosts = useMemo(() => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    if (!subtree) return { nodes, edges };
    // Стрелки поддерева ведут между его нодами либо из ноды-владельца холста.
    const present = new Set<string>();
    for (const l of subtree.levels) {
      if (l.canvas.ownerNode) present.add(l.canvas.ownerNode);
      l.nodes.forEach((m) => present.add(m.id));
    }
    for (const l of subtree.levels) {
      const d = l.depth;
      const prog = progressMap(l.progress);
      const cls = `ghost-d${Math.min(d, GHOST_OPACITY.length)}`;
      if (!l.canvas.ownerNode) {
        const frame = orphanFrame(
          l.canvas.id,
          l.nodes,
          (id) => measured.get(id),
          ghostNodeZ(d) - 1,
          cls,
        );
        if (frame) nodes.push(frame);
      }
      for (const m of l.nodes) {
        nodes.push({
          id: m.id,
          type: "ghost",
          position: { x: m.x, y: m.y },
          data: {
            model: m,
            depth: d,
            path: [...l.path, m.title || (m.kind === "task" ? "Без названия" : "Заметка")],
            progress: prog.get(m.id),
          },
          draggable: false,
          selectable: false,
          deletable: false,
          connectable: false,
          focusable: false,
          zIndex: ghostNodeZ(d),
          className: cls,
          measured: measured.get(m.id),
        });
      }
      for (const e of l.edges) {
        if (!present.has(e.source) || !present.has(e.target)) continue;
        edges.push({
          ...toFlowEdge(e),
          selectable: false,
          deletable: false,
          focusable: false,
          interactionWidth: 0,
          zIndex: ghostEdgeZ(d),
          className: `is-ghost ${cls}`,
        });
      }
    }
    return { nodes, edges };
  }, [subtree, measured]);

  // Выделено с подзадачами (ТЗ §4.12.2): просвечивающие вложенные — с аутлайном.
  const ghostNodes = useMemo(() => {
    if (!nestedIds?.size) return ghosts.nodes;
    return ghosts.nodes.map((n) =>
      nestedIds.has(n.id) ? { ...n, className: `${n.className ?? ""} is-nested-sel` } : n,
    );
  }, [ghosts.nodes, nestedIds]);

  const near = useMemo(() => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    if (!neighbors) return { nodes, edges };
    for (const l of neighbors.levels) {
      const prog = progressMap(l.progress);
      const present = new Set(l.nodes.map((m) => m.id));
      for (const m of l.nodes) {
        nodes.push({
          id: m.id,
          type: "neighbor",
          position: { x: m.x, y: m.y },
          data: { model: m, parentTitle: l.parentTitle, chain: l.canvasChain, progress: prog.get(m.id) },
          draggable: false,
          selectable: false,
          deletable: false,
          connectable: false,
          focusable: false,
          zIndex: NEIGHBOR_NODE_Z,
          className: "is-neighbor",
          measured: measured.get(m.id),
        });
      }
      // Стрелки «родитель ↔ подзадача» соседа не видны: его родитель — под тинтом.
      for (const e of l.edges) {
        if (!present.has(e.source) || !present.has(e.target)) continue;
        edges.push({
          ...toFlowEdge(e),
          selectable: false,
          deletable: false,
          focusable: false,
          interactionWidth: 0,
          zIndex: NEIGHBOR_EDGE_Z,
          className: "is-neighbor",
        });
      }
    }
    return { nodes, edges };
  }, [neighbors, measured]);

  return useMemo(() => {
    const head = [anchor, orphanAnchor].filter((n): n is FlowNode => !!n);
    const nodes = [...head, ...near.nodes, ...ghostNodes];
    const edges = near.edges.length ? [...near.edges, ...ghosts.edges] : ghosts.edges;
    return {
      nodes: nodes.length ? nodes : EMPTY,
      edges: edges.length ? edges : EMPTY_EDGES,
      ids: new Set(nodes.map((n) => n.id)),
      edgeIds: new Set(edges.map((e) => e.id)),
      ghostIds: new Set(nodes.filter((n) => n.type !== "anchor").map((n) => n.id)),
      measured,
    };
  }, [anchor, orphanAnchor, near, ghostNodes, ghosts.edges, measured]);
}
