// «Чужие» ноды уровня стека слоёв:
// - якорь (anchor) — нода-родитель слоя поверх тинта, на своём месте (ТЗ §4.5);
// - просвечивающие ноды и стрелки вложенных уровней (ghost, ТЗ §4.5.1).
//
// React Flow держит размеры нод в `measured`; объекты этих нод собираются
// здесь заново при изменении данных, поэтому размеры запоминаются отдельно
// и подставляются — иначе нода на кадр пропадала бы до перемера.

import { useMemo, useRef } from "react";

import { progressMap, progressOf, toFlowEdge, type FlowEdge, type FlowNode } from "../canvas/flow";
import { useGraph } from "../store/graph";

/** Непрозрачность просвечивающих уровней: +1, +2, +3 и глубже (ТЗ §4.5.1). Зеркало — styles.css. */
export const GHOST_OPACITY = [0.55, 0.3, 0.15] as const;

/** z-index: текущий уровень — 0, якорь — над ним, вложенные — ниже, глубже — ещё ниже. */
const ghostNodeZ = (depth: number) => -10 * depth;
const ghostEdgeZ = (depth: number) => -10 * depth - 5;

export interface LayerExtras {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** id всех особых нод (якорь + просвечивающие). */
  ids: Set<string>;
  edgeIds: Set<string>;
  ghostIds: Set<string>;
  /** Запомненные размеры особых нод. */
  measured: Map<string, { width: number; height: number }>;
}

const EMPTY: FlowNode[] = [];
const EMPTY_EDGES: FlowEdge[] = [];

export function useLayerExtras(
  canvasId: string,
  parentCanvasId: string | undefined,
  active: boolean,
): LayerExtras {
  const measured = useRef(new Map<string, { width: number; height: number }>()).current;

  const ownerId = useGraph((s) => s.canvases[canvasId]?.canvas.ownerNode ?? null);
  const ownerNode = useGraph((s) =>
    parentCanvasId && ownerId
      ? s.canvases[parentCanvasId]?.nodes.find((n) => n.id === ownerId)
      : undefined,
  );
  const ownNodes = useGraph((s) => s.canvases[canvasId]?.nodes);
  const subtree = useGraph((s) =>
    active && s.subtree?.canvasId === canvasId ? s.subtree : null,
  );

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

  return useMemo(() => {
    const nodes = anchor ? [anchor, ...ghosts.nodes] : ghosts.nodes;
    return {
      nodes: nodes.length ? nodes : EMPTY,
      edges: ghosts.edges.length ? ghosts.edges : EMPTY_EDGES,
      ids: new Set(nodes.map((n) => n.id)),
      edgeIds: new Set(ghosts.edges.map((e) => e.id)),
      ghostIds: new Set(ghosts.nodes.map((n) => n.id)),
      measured,
    };
  }, [anchor, ghosts, measured]);
}
