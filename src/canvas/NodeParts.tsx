// Общие части визуала нод: иконка статуса, бейдж прогресса, заголовок без
// редактирования. Используются обычными нодами, нодой-родителем слоя (anchor)
// и просвечивающими нодами (ghost), чтобы все три выглядели одинаково.

import type { MouseEvent as ReactMouseEvent } from "react";
import { Circle, CircleCheck, CircleDot } from "lucide-react";

import type { NodeModel, TaskStatus } from "../api";
import type { Progress } from "./flow";

export const STATUS_META: Record<TaskStatus, { icon: typeof Circle; label: string }> = {
  todo: { icon: Circle, label: "К выполнению" },
  in_progress: { icon: CircleDot, label: "В работе" },
  done: { icon: CircleCheck, label: "Готово" },
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  const { icon: Icon } = STATUS_META[status];
  return <Icon size={16} strokeWidth={2.2} />;
}

/** Бейдж «выполнено/всего» (ТЗ §4.3). Двойной клик — вход в слой (если передан). */
export function ProgressBadge({
  progress,
  title,
  onDoubleClick,
}: {
  progress: Progress | undefined;
  title?: string;
  onDoubleClick?: (e: ReactMouseEvent) => void;
}) {
  if (!progress) return null;
  const complete = progress.done === progress.total;
  return (
    <span
      className={`progress-badge${complete ? " is-complete" : ""}${onDoubleClick ? " nodrag" : ""}`}
      title={title}
      onDoubleClick={onDoubleClick}
    >
      {progress.done}/{progress.total}
    </span>
  );
}

export function PlainTitle({ model, placeholder }: { model: NodeModel; placeholder: string }) {
  return (
    <div className={model.title ? "node-title" : "node-title is-empty"}>
      {model.title || placeholder}
    </div>
  );
}

