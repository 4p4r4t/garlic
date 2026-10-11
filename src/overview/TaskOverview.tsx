// Обзор задач (ТЗ §4.6.1): колонка круглых кнопок у правого края холста
// и окно поверх поля с табами по статусам. Таб — все задачи пространства
// (все уровни) с этим статусом, деревом по родителям; предки с другим
// статусом — приглушённый контекст. Клик по задаче — закрыть окно и
// провалиться к ней (цепочка слоёв + выделение + камера к ноде).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Circle, CircleCheck, CircleDot, X } from "lucide-react";

import { api, type SpaceTask, type TaskStatus } from "../api";
import { PALETTE } from "../canvas/palette";
import { cameraFocus } from "../layers/CameraFocus";
import { NEXT_STATUS, useGraph } from "../store/graph";
import { buildTree, canvasChain, type TreeRow } from "./tree";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];

const META: Record<TaskStatus, { icon: typeof Circle; label: string }> = {
  todo: { icon: Circle, label: "К выполнению" },
  in_progress: { icon: CircleDot, label: "В работе" },
  done: { icon: CircleCheck, label: "Готово" },
};

export function TaskOverview() {
  const spaceId = useGraph((s) => s.activeSpaceId);
  const revealNode = useGraph((s) => s.revealNode);
  const setTaskStatus = useGraph((s) => s.setTaskStatus);
  const showError = useGraph((s) => s.showError);

  /** Открытый таб; null — окно закрыто. */
  const [tab, setTab] = useState<TaskStatus | null>(null);
  const [tasks, setTasks] = useState<SpaceTask[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /**
   * Задачи, чей статус сменили из этого таба: остаются на месте (с новым
   * маркером), пока не сменят таб или не закроют окно, — чтобы строка не
   * исчезала из-под курсора и статус можно было прокрутить дальше.
   */
  const [sticky, setSticky] = useState<Set<string>>(() => new Set());
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!spaceId) return;
    const seq = ++loadSeq.current;
    try {
      const list = await api.listSpaceTasks(spaceId);
      if (seq === loadSeq.current) setTasks(list);
    } catch (e) {
      showError(e);
    }
  }, [spaceId, showError]);

  const open = tab !== null;
  // При открытии и при смене пространства — свежий список.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const close = useCallback(() => {
    setTab(null);
    setSticky(new Set());
  }, []);

  const toggle = (s: TaskStatus) => {
    if (tab === s) {
      close();
    } else {
      if (tab === null) setTasks(null);
      setTab(s);
      setSticky(new Set());
    }
  };

  // Esc закрывает окно раньше всех (иначе он закрыл бы слой); Delete не
  // доходит до холста, пока окно открыто.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  const counts = useMemo(() => {
    const c: Record<TaskStatus, number> = { todo: 0, in_progress: 0, done: 0 };
    tasks?.forEach((t) => c[t.status]++);
    return c;
  }, [tasks]);
  const tree = useMemo(
    () =>
      tasks && tab ? buildTree(tasks, (t) => t.status === tab || sticky.has(t.id)) : [],
    [tasks, tab, sticky],
  );

  const goTo = async (task: SpaceTask) => {
    close();
    await revealNode(canvasChain(task, byId), task.id);
    const { layers } = useGraph.getState();
    if (layers[layers.length - 1] === task.canvasId) cameraFocus.request(task.canvasId, task.id);
  };

  const cycle = async (task: SpaceTask) => {
    const next = NEXT_STATUS[task.status];
    setSticky((s) => new Set(s).add(task.id));
    setTasks((list) => list?.map((t) => (t.id === task.id ? { ...t, status: next } : t)) ?? list);
    await setTaskStatus(task.canvasId, task.id, next, task.parentNodeId);
    await load();
  };

  const toggleCollapsed = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  return (
    <>
      {open && <div className="ov-backdrop" onClick={close} />}
      {open && (
        <div className="ov-panel" role="dialog" aria-label="Обзор задач">
          <div className="ov-head">
            <div className="ov-tabs" role="tablist">
              {STATUSES.map((s) => {
                const Icon = META[s].icon;
                return (
                  <button
                    key={s}
                    role="tab"
                    aria-selected={tab === s}
                    className={`ov-tab ov-st-${s}${tab === s ? " is-active" : ""}`}
                    onClick={() => {
                      setTab(s);
                      setSticky(new Set());
                    }}
                  >
                    <Icon size={15} strokeWidth={2.2} />
                    <span>{META[s].label}</span>
                    <span className="ov-count">{tasks ? counts[s] : "…"}</span>
                  </button>
                );
              })}
            </div>
            <button className="ov-close" title="Закрыть (Esc)" onClick={close}>
              <X size={16} />
            </button>
          </div>
          <div className="ov-body">
            {tasks === null ? (
              <div className="ov-empty">Загрузка…</div>
            ) : tree.length === 0 ? (
              <div className="ov-empty">Нет задач со статусом «{META[tab].label}»</div>
            ) : (
              <ul className="ov-tree" role="tree">
                {tree.map((row) => (
                  <Row
                    key={row.task.id}
                    row={row}
                    collapsed={collapsed}
                    onToggle={toggleCollapsed}
                    onOpen={goTo}
                    onCycle={cycle}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <div className="ov-rail">
        {STATUSES.map((s) => {
          const Icon = META[s].icon;
          return (
            <button
              key={s}
              className={`ov-rail-btn ov-st-${s}${tab === s ? " is-active" : ""}`}
              data-tip={META[s].label}
              aria-label={META[s].label}
              aria-pressed={tab === s}
              onClick={() => toggle(s)}
            >
              <Icon size={18} strokeWidth={2.2} />
            </button>
          );
        })}
      </div>
    </>
  );
}

interface RowProps {
  row: TreeRow;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (task: SpaceTask) => void;
  onCycle: (task: SpaceTask) => void;
}

function Row({ row, collapsed, onToggle, onOpen, onCycle }: RowProps) {
  const { task, match, children } = row;
  const isCollapsed = collapsed.has(task.id);
  const Icon = META[task.status].icon;
  const swatch = task.color ? PALETTE[task.color] : undefined;
  return (
    <li role="treeitem" aria-expanded={children.length ? !isCollapsed : undefined}>
      <div className={`ov-row ov-st-${task.status}${match ? "" : " is-context"}`}>
        {children.length ? (
          <button
            className={`ov-chevron${isCollapsed ? "" : " is-open"}`}
            title={isCollapsed ? "Развернуть" : "Свернуть"}
            onClick={() => onToggle(task.id)}
          >
            <ChevronRight size={14} />
          </button>
        ) : (
          <span className="ov-chevron is-leaf" />
        )}
        <button
          className="ov-status"
          title={`${META[task.status].label} — сменить статус`}
          onClick={() => onCycle(task)}
        >
          <Icon size={15} strokeWidth={2.2} />
        </button>
        <button className="ov-title" title="Перейти к задаче" onClick={() => onOpen(task)}>
          {swatch && <span className="ov-swatch" style={{ background: swatch }} />}
          <span className={task.title ? "ov-title-text" : "ov-title-text is-empty"}>
            {task.title || "Без названия"}
          </span>
          {children.length > 0 && isCollapsed && (
            <span className="ov-hidden-count">{countRows(children)}</span>
          )}
        </button>
      </div>
      {children.length > 0 && !isCollapsed && (
        <ul role="group">
          {children.map((c) => (
            <Row
              key={c.task.id}
              row={c}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
              onCycle={onCycle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Сколько подходящих задач спрятано в свёрнутом узле. */
function countRows(rows: TreeRow[]): number {
  return rows.reduce((n, r) => n + (r.match ? 1 : 0) + countRows(r.children), 0);
}
