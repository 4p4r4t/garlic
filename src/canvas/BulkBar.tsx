import { Trash2 } from "lucide-react";

import type { TaskStatus } from "../api";
import { StatusIcon, STATUS_META } from "./NodeParts";

/** «Чужая» — тоже групповым действием; «Заблокирована» — только блокировкой (ТЗ §4.12.7). */
const STATUSES: TaskStatus[] = ["todo", "in_progress", "done", "foreign"];

interface Props {
  /** Сколько нод выделено (≥ 2). */
  count: number;
  /** Сколько из них задач (статус меняется только у них). */
  tasks: number;
  onStatus: (status: TaskStatus) => void;
  onDelete: () => void;
}

/**
 * Групповые действия (ТЗ §4.3, v1.2): плавающая панель внизу по центру, пока
 * на верхнем уровне выделено ≥ 2 нод. Статус — всем выделенным задачам
 * (заметки и заблокированные пропускаются), «Удалить» — одно подтверждение на всё.
 */
export function BulkBar({ count, tasks, onStatus, onDelete }: Props) {
  return (
    <div
      className="bulk-bar"
      role="toolbar"
      aria-label="Действия с выделенным"
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="bulk-count">Выделено: {count}</span>
      <span className="bulk-sep" aria-hidden="true" />
      <span className="bulk-label">Статус</span>
      {STATUSES.map((st) => (
        <button
          key={st}
          type="button"
          className={`bulk-btn bulk-status status-${st}`}
          title={tasks ? `${STATUS_META[st].label} — всем выделенным задачам` : "Среди выделенного нет задач"}
          disabled={!tasks}
          onClick={() => onStatus(st)}
        >
          <StatusIcon status={st} />
          <span>{STATUS_META[st].label}</span>
        </button>
      ))}
      <span className="bulk-sep" aria-hidden="true" />
      <button
        type="button"
        className="bulk-btn is-danger"
        title="Удалить выделенное"
        onClick={onDelete}
      >
        <Trash2 size={15} strokeWidth={2} />
        <span>Удалить</span>
      </button>
    </div>
  );
}
