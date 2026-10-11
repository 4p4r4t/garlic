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
 * `inert` — невидимые и неподключаемые: нужны только как точки крепления
 * стрелок (просвечивающие ноды, ТЗ §4.5.1).
 */
export function NodeHandles({ inert = false }: { inert?: boolean }) {
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          className={inert ? "g-handle is-inert" : "g-handle"}
          isConnectable={!inert}
        />
      ))}
    </>
  );
}
