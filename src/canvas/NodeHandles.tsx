import { Handle, Position } from "@xyflow/react";

import type { HandleSide } from "../api";

const SIDES: [HandleSide, Position][] = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
];

/**
 * 4 хэндла по сторонам ноды. Все — `source`: холст работает в
 * ConnectionMode.Loose, поэтому каждый хэндл служит и началом, и концом стрелки.
 */
export function NodeHandles() {
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle key={side} id={side} type="source" position={position} className="g-handle" />
      ))}
    </>
  );
}
