import { getBezierPath, Position, ViewportPortal, type XYPosition } from "@xyflow/react";

import type { HandleSide } from "../api";

const SIDE_POSITION: Record<HandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

interface Props {
  from: XYPosition;
  fromPosition: Position;
  to: XYPosition;
  /** Сторона будущей ноды, в которую войдёт стрелка. */
  toSide: HandleSide;
}

/**
 * «Призрачная» стрелка от хэндла до точки, где отпустили стрелку (ТЗ §4.2.1).
 * Рисуется в координатах холста, поэтому следует за вьюпортом.
 */
export function GhostEdge({ from, fromPosition, to, toSide }: Props) {
  const [path] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: fromPosition,
    targetX: to.x,
    targetY: to.y,
    targetPosition: SIDE_POSITION[toSide],
  });
  return (
    <ViewportPortal>
      <svg className="ghost-edge" aria-hidden="true">
        <path d={path} />
        <circle cx={to.x} cy={to.y} r={3.5} />
      </svg>
    </ViewportPortal>
  );
}
