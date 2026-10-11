import { memo } from "react";
import type { NodeProps } from "@xyflow/react";

import { useGraph } from "../store/graph";
import type { FlowNode } from "./flow";
import { NodeHandles } from "./NodeHandles";
import { ProgressBadge, StatusIcon, STATUS_META } from "./NodeParts";
import { NodeTitle } from "./NodeTitle";
import { fillStyle } from "./palette";

function TaskNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const cycleStatus = useGraph((s) => s.cycleStatus);
  const enterLayer = useGraph((s) => s.enterLayer);
  const status = m.status ?? "todo";
  const { label } = STATUS_META[status];

  return (
    <div
      className={`g-node g-task status-${status}${selected ? " is-selected" : ""}${m.color ? " is-filled" : ""}`}
      style={fillStyle(m.color)}
    >
      <NodeHandles />
      <button
        type="button"
        className="status-marker nodrag"
        title={`${label} — нажмите, чтобы сменить`}
        aria-label={`Статус: ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          cycleStatus(m.canvasId, m.id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <StatusIcon status={status} />
      </button>
      <NodeTitle model={m} placeholder="Без названия" />
      <ProgressBadge
        progress={data.progress}
        title="Подзадачи: выполнено / всего. Двойной клик — открыть"
        onDoubleClick={(e) => {
          e.stopPropagation();
          void enterLayer(m.id);
        }}
      />
    </div>
  );
}

export const TaskNode = memo(TaskNodeImpl);
