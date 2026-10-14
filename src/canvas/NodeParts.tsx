// Общие части визуала нод: иконка статуса, бейдж прогресса, заголовок без
// редактирования. Используются обычными нодами, нодой-родителем слоя (anchor)
// и просвечивающими нодами (ghost), чтобы все три выглядели одинаково.

import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Circle, CircleCheck, CircleDot, CircleSlash, CircleUserRound } from "lucide-react";

import type { NodeModel, TaskStatus } from "../api";
import type { Progress } from "./flow";

export const STATUS_META: Record<TaskStatus, { icon: typeof Circle; label: string }> = {
  todo: { icon: Circle, label: "К выполнению" },
  in_progress: { icon: CircleDot, label: "В работе" },
  done: { icon: CircleCheck, label: "Готово" },
  blocked: { icon: CircleSlash, label: "Заблокирована" },
  foreign: { icon: CircleUserRound, label: "Чужая" },
};

/** Статусы, которые крутит маркер / Space / групповая панель (ТЗ §4.12.7). */
export const CYCLE_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done"];
/** Все статусы в порядке показа (списки, настройки). */
export const ALL_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "blocked", "foreign"];

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


/** Наклон стикера (−3…+3°), постоянный для id — стикеры «наклеены» вразнобой. */
export function stickerTilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = [-3, 2.5, -1.5, 3, -2.5, 1.5][Math.abs(h) % 6];
  return r;
}

/**
 * Карточка стикера (ТЗ §4.12.7): компактная, чуть повёрнутая, цвет — статуса
 * (по умолчанию «Чужая» — оранжевый). `title` — заголовок (редактор или текст),
 * `marker` — маркер статуса (кнопка у живого стикера, значок у картинки).
 */
export function StickerCard({
  model,
  fill,
  className,
  title,
  marker,
  children,
}: {
  model: NodeModel;
  fill: CSSProperties | undefined;
  className?: string;
  title: ReactNode;
  marker: ReactNode;
  children?: ReactNode;
}) {
  const status = model.status ?? "foreign";
  return (
    <div
      className={`g-node g-task g-sticker status-${status}${fill ? " is-filled" : ""}${className ? ` ${className}` : ""}`}
      style={{ ...fill, ["--tilt" as string]: `${stickerTilt(model.id)}deg` }}
      title={`${STATUS_META[status].label}: ${model.title || "без названия"} — стикер; оторвите, чтобы сделать отдельной задачей`}
    >
      {children}
      <span className="sticker-tape" aria-hidden="true" />
      <div className="sticker-body">
        {marker}
        {title}
      </div>
    </div>
  );
}
