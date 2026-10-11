import { memo } from "react";
import type { NodeProps } from "@xyflow/react";

import { useGraph, useStatusColors } from "../store/graph";
import type { FlowNode } from "./flow";
import { NodeHandles } from "./NodeHandles";
import { ProgressBadge, StatusIcon, STATUS_META } from "./NodeParts";
import { NodeTitle } from "./NodeTitle";
import { fillStyle, nodeFillColor } from "./palette";

function TaskNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const cycleStatus = useGraph((s) => s.cycleStatus);
  const enterLayer = useGraph((s) => s.enterLayer);
  const status = m.status ?? "todo";
  const { label } = STATUS_META[status];
  const fill = nodeFillColor(m, useStatusColors());

  return (
    <div
      className={`g-node g-task status-${status}${selected ? " is-selected" : ""}${fill ? " is-filled" : ""}`}
      style={fillStyle(fill)}
    >
      <NodeHandles />
      <NodeTitle model={m} placeholder="Без названия" />
      <div className="node-foot">
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
        <span className="status-label">{label}</span>
        <ProgressBadge
          progress={data.progress}
          title="Подзадачи: выполнено / всего. Двойной клик — открыть"
          onDoubleClick={(e) => {
            e.stopPropagation();
            void enterLayer(m.id);
          }}
        />
      </div>
    </div>
  );
}

export const TaskNode = memo(TaskNodeImpl);
