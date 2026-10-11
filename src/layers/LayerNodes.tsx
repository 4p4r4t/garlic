// Особые ноды стека слоёв: нода-родитель поверх тинта (anchor, ТЗ §4.5) и
// просвечивающая нода вложенного уровня (ghost, ТЗ §4.5.1).

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";

import type { FlowNode } from "../canvas/flow";
import { NodeHandles } from "../canvas/NodeHandles";
import { notePreview, PlainTitle, ProgressBadge, StatusIcon } from "../canvas/NodeParts";
import { fillStyle } from "../canvas/palette";

/**
 * Нода-родитель открытого слоя: выглядит ровно как на своём холсте и лежит на
 * том же месте, но поверх тинта. Не редактируется и не двигается (это нода
 * нижнего уровня); клик — выход из слоя; хэндлы работают как начало стрелки
 * «родитель → подзадача». Бейдж прогресса — живой, из задач слоя.
 */
function AnchorNodeImpl({ data }: NodeProps<FlowNode>) {
  const m = data.model;
  const status = m.status ?? "todo";
  return (
    <div
      className={`g-node g-task status-${status} is-anchor${m.color ? " is-filled" : ""}`}
      style={fillStyle(m.color)}
      title="Клик — выйти из слоя"
    >
      <NodeHandles />
      <span className="status-marker">
        <StatusIcon status={status} />
      </span>
      <PlainTitle model={m} placeholder="Без названия" />
      <ProgressBadge progress={data.progress} />
    </div>
  );
}

/**
 * Просвечивающая нода: только визуал; хэндлы невидимые и неподключаемые (на
 * них крепятся стрелки уровня). Прозрачность — по глубине (CSS).
 */
function GhostNodeImpl({ data }: NodeProps<FlowNode>) {
  const m = data.model;
  const depth = Math.min(data.depth ?? 1, 3);
  const fill = fillStyle(m.color);
  if (m.kind === "note") {
    const text = notePreview(m.body);
    return (
      <div className={`g-node g-note is-ghost ghost-d${depth}${m.color ? " is-filled" : ""}`} style={fill}>
        <NodeHandles inert />
        <div className="note-head">
          <StickyNote className="note-icon" size={14} strokeWidth={2} />
          <PlainTitle model={m} placeholder="Заметка" />
        </div>
        {text && <div className="note-preview">{text}</div>}
      </div>
    );
  }
  const status = m.status ?? "todo";
  return (
    <div
      className={`g-node g-task status-${status} is-ghost ghost-d${depth}${m.color ? " is-filled" : ""}`}
      style={fill}
    >
      <NodeHandles inert />
      <span className="status-marker">
        <StatusIcon status={status} />
      </span>
      <PlainTitle model={m} placeholder="Без названия" />
      <ProgressBadge progress={data.progress} />
    </div>
  );
}

export const AnchorNode = memo(AnchorNodeImpl);
export const GhostNode = memo(GhostNodeImpl);
