import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Circle, CircleCheck, CircleDot } from "lucide-react";

import type { TaskStatus } from "../api";
import { useGraph } from "../store/graph";
import type { FlowNode } from "./flow";
import { NodeHandles } from "./NodeHandles";
import { NodeTitle } from "./NodeTitle";
import { fillStyle } from "./palette";

const STATUS_META: Record<TaskStatus, { icon: typeof Circle; label: string }> = {
  todo: { icon: Circle, label: "К выполнению" },
  in_progress: { icon: CircleDot, label: "В работе" },
  done: { icon: CircleCheck, label: "Готово" },
};

function TaskNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const cycleStatus = useGraph((s) => s.cycleStatus);
  const status = m.status ?? "todo";
  const { icon: Icon, label } = STATUS_META[status];

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
        <Icon size={16} strokeWidth={2.2} />
      </button>
      <NodeTitle model={m} placeholder="Без названия" />
      {/* M3: бейдж прогресса подзадач «выполнено/всего» */}
    </div>
  );
}

export const TaskNode = memo(TaskNodeImpl);
