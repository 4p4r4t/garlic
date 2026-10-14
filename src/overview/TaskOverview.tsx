// Боковая панель списков по статусам (ТЗ §4.6.1, §4.12.5–4.12.6): вертикальная
// панель у правого края, открывается кнопками статусов и закрывается ТОЛЬКО
// повторным нажатием той же кнопки (ни Esc, ни клик мимо; холст остаётся
// рабочим). Задачи — по всем пространствам (фильтр в шапке), без дерева:
// прямоугольные блоки друг под другом с путём `Пространство › Родитель › …`.
// Блоки перетаскиваются — ручной порядок (очередь выполнения) в БД
// (`reorder_tasks`). В «В работе» есть закрепление: задачи списка остаются,
// когда становятся «Готово» (зелёные).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Layers, Pin } from "lucide-react";

import { api, APP_STATE, type PanelTask, type TaskStatus } from "../api";
import { ALL_STATUSES, STATUS_META } from "../canvas/NodeParts";
import { fillStyle, PALETTE } from "../canvas/palette";
import { cameraFocus } from "../layers/CameraFocus";
import { NEXT_STATUS, useGraph, useStatusColors } from "../store/graph";

/** Кнопки рейла: все статусы, включая «Заблокирована» и «Чужая» (ТЗ §4.12.7). */
const STATUSES = ALL_STATUSES;
const META = STATUS_META;

const MIN_W = 260;
const MAX_W = 640;
const DEFAULT_W = 340;
const DRAG_THRESHOLD = 5;

interface PinState {
  on: boolean;
  /** Порядок списка «В работе» на момент закрепления + присоединившиеся. */
  ids: string[];
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const persist = (key: string, value: unknown) =>
  api.setAppState(key, JSON.stringify(value)).catch(() => undefined);

export function TaskOverview() {
  const activeSpaceId = useGraph((s) => s.activeSpaceId);
  const spaces = useGraph((s) => s.spaces);
  const switchSpace = useGraph((s) => s.switchSpace);
  const revealNode = useGraph((s) => s.revealNode);
  const setTaskStatus = useGraph((s) => s.setTaskStatus);
  const showError = useGraph((s) => s.showError);
  const statusColors = useStatusColors();

  /** Открытый статус; null — панель закрыта. */
  const [tab, setTab] = useState<TaskStatus | null>(null);
  const [tasks, setTasks] = useState<PanelTask[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [pin, setPin] = useState<PinState>({ on: false, ids: [] });
  const [width, setWidth] = useState(DEFAULT_W);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const loadSeq = useRef(0);

  // Сохранённые настройки панели.
  useEffect(() => {
    void (async () => {
      try {
        const [h, p, w] = await Promise.all([
          api.getAppState(APP_STATE.panelHiddenSpaces),
          api.getAppState(APP_STATE.panelPinned),
          api.getAppState(APP_STATE.panelWidth),
        ]);
        setHidden(new Set(parseJson<string[]>(h, [])));
        const pp = parseJson<Partial<PinState>>(p, {});
        setPin({ on: !!pp.on, ids: Array.isArray(pp.ids) ? pp.ids : [] });
        const wn = Number(w);
        if (wn >= MIN_W && wn <= MAX_W) setWidth(wn);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const list = await api.listAllTasks();
      if (seq === loadSeq.current) setTasks(list);
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  const open = tab !== null;
  // Открытие — свежий список; закрепление работает и при закрытой панели.
  useEffect(() => {
    if (ready && (open || pin.on)) void load();
  }, [ready, open, pin.on, load]);

  // Живые обновления: подпись задач в кэше графа и список пространств; при
  // изменении статуса/названия/цвета/состава — перечитать (с дебаунсом).
  const signature = useGraph((s) => {
    const parts: string[] = [];
    for (const v of Object.values(s.canvases)) {
      for (const n of v.nodes) {
        const m = n.data?.model;
        if (m && m.kind === "task") parts.push(`${m.id}|${m.title}|${m.status}|${m.color}`);
      }
    }
    parts.sort();
    for (const sp of s.spaces) parts.push(`#${sp.id}|${sp.name}`);
    return parts.join("\n");
  });
  const firstSig = useRef(true);
  useEffect(() => {
    if (firstSig.current) {
      firstSig.current = false;
      return;
    }
    if (!ready || !(open || pin.on)) return;
    const t = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(t);
  }, [signature, ready, open, pin.on, load]);

  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  // Закрепление: список «В работе» держит свои задачи, пока они in_progress/done;
  // новые in_progress присоединяются в конец; удалённые и ушедшие в todo — убираются.
  useEffect(() => {
    if (!pin.on || !tasks) return;
    const keep = pin.ids.filter((id) => {
      const t = byId.get(id);
      return t && (t.status === "in_progress" || t.status === "done");
    });
    const known = new Set(keep);
    const joined = tasks.filter((t) => t.status === "in_progress" && !known.has(t.id));
    const next = [...keep, ...joined.map((t) => t.id)];
    if (next.length !== pin.ids.length || next.some((id, i) => id !== pin.ids[i])) {
      const p = { on: true, ids: next };
      setPin(p);
      void persist(APP_STATE.panelPinned, p);
    }
  }, [pin, tasks, byId]);

  const spaceVisible = useCallback((t: PanelTask) => !hidden.has(t.spaceId), [hidden]);

  /** Полный список статуса (все пространства) в порядке очереди. */
  const fullList = useMemo(
    () => (tasks && tab ? tasks.filter((t) => t.status === tab) : []),
    [tasks, tab],
  );
  const pinnedView = tab === "in_progress" && pin.on;
  const shown = useMemo(() => {
    if (!tasks || !tab) return [];
    if (pinnedView) {
      return pin.ids.map((id) => byId.get(id)).filter((t): t is PanelTask => !!t && spaceVisible(t));
    }
    return fullList.filter(spaceVisible);
  }, [tasks, tab, pinnedView, pin.ids, byId, fullList, spaceVisible]);

  const toggle = (s: TaskStatus) => {
    setMenuOpen(false);
    if (tab === s) {
      setTab(null);
    } else {
      setTab(s);
    }
  };

  const toggleSpace = (id: string) => {
    const next = new Set(hidden);
    if (!next.delete(id)) next.add(id);
    setHidden(next);
    void persist(APP_STATE.panelHiddenSpaces, [...next]);
  };

  const togglePin = () => {
    if (pin.on) {
      const p = { on: false, ids: [] };
      setPin(p);
      void persist(APP_STATE.panelPinned, p);
    } else {
      const ids = (tasks ?? []).filter((t) => t.status === "in_progress").map((t) => t.id);
      const p = { on: true, ids };
      setPin(p);
      void persist(APP_STATE.panelPinned, p);
    }
  };

  const goTo = async (task: PanelTask) => {
    if (task.spaceId !== activeSpaceId) await switchSpace(task.spaceId);
    await revealNode(task.canvasChain, task.id);
    const { layers } = useGraph.getState();
    if (layers[layers.length - 1] === task.canvasId) cameraFocus.request(task.canvasId, task.id);
  };

  const cycle = async (task: PanelTask) => {
    const next = NEXT_STATUS[task.status];
    // «Заблокирована» / «Чужая» — только через ПКМ на холсте.
    if (!next) return;
    setTasks((list) => list?.map((t) => (t.id === task.id ? { ...t, status: next } : t)) ?? list);
    await setTaskStatus(task.canvasId, task.id, next, task.parentNodeId);
    await load();
  };

  /** Новый порядок видимых блоков → ранги в БД (скрытые фильтром остаются на своих местах). */
  const applyOrder = (visibleIds: string[]) => {
    if (!tab) return;
    if (pinnedView) {
      // Закреплённый список: порядок хранится в pin.ids (скрытые фильтром — на местах).
      const vis = new Set(visibleIds);
      let k = 0;
      const ids = pin.ids.map((id) => (vis.has(id) ? visibleIds[k++] : id));
      const p = { on: true, ids };
      setPin(p);
      void persist(APP_STATE.panelPinned, p);
    }
    const inTab = (id: string) => byId.get(id)?.status === tab;
    const vis = new Set(visibleIds.filter(inTab));
    const queue = visibleIds.filter(inTab);
    let k = 0;
    const base = fullList.map((t) => t.id);
    const full = base.map((id) => (vis.has(id) ? queue[k++] : id));
    // оптимистично переставить в кэше
    setTasks((list) => {
      if (!list) return list;
      const pos = new Map(full.map((id, i) => [id, i]));
      const same = list.filter((t) => t.status === tab);
      const sorted = [...same].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
      let j = 0;
      return list.map((t) => (t.status === tab ? sorted[j++] : t));
    });
    api.reorderTasks(full).catch((e) => {
      showError(e);
      void load();
    });
  };

  // ---- ширина (тянем левый край) ----
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      setWidth(w);
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      void api.setAppState(APP_STATE.panelWidth, String(Math.round(w))).catch(() => undefined);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const visibleSpaces = spaces.filter((sp) => !hidden.has(sp.id)).length;

  return (
    <>
      {open && tab && (
        <aside className="qp-panel" style={{ width }} aria-label="Списки задач">
          <div className="qp-resize" onPointerDown={startResize} title="Потяните, чтобы изменить ширину" />
          <div className="qp-head">
            <span className={`qp-title ov-st-${tab}`}>
              {(() => {
                const Icon = META[tab].icon;
                return <Icon size={16} strokeWidth={2.2} />;
              })()}
              {META[tab].label}
              <span className="ov-count">{tasks ? shown.length : "…"}</span>
            </span>
            <div className="qp-head-actions">
              {tab === "in_progress" && (
                <button
                  className={`qp-iconbtn${pin.on ? " is-on" : ""}`}
                  title={
                    pin.on
                      ? "Список закреплён — снять (готовые уйдут из списка)"
                      : "Закрепить список: готовые задачи остаются зелёными"
                  }
                  aria-pressed={pin.on}
                  onClick={togglePin}
                >
                  <Pin size={15} />
                </button>
              )}
              <div className="qp-spaces">
                <button
                  className="qp-spaces-btn"
                  title="Пространства"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <Layers size={14} />
                  <span>
                    {visibleSpaces}/{spaces.length}
                  </span>
                  <ChevronDown size={13} />
                </button>
                {menuOpen && (
                  <>
                    <div className="qp-menu-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="qp-menu" role="menu" aria-label="Пространства">
                      <div className="qp-menu-title">Пространства</div>
                      {spaces.map((sp) => {
                        const on = !hidden.has(sp.id);
                        return (
                          <button
                            key={sp.id}
                            className="qp-menu-item"
                            role="menuitemcheckbox"
                            aria-checked={on}
                            onClick={() => toggleSpace(sp.id)}
                          >
                            <span className={`qp-check${on ? " is-on" : ""}`}>
                              {on && <Check size={12} strokeWidth={3} />}
                            </span>
                            <span className="qp-menu-name">{sp.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="qp-body">
            {tasks === null ? (
              <div className="ov-empty">Загрузка…</div>
            ) : shown.length === 0 ? (
              <div className="ov-empty">Нет задач со статусом «{META[tab].label}»</div>
            ) : (
              <BlockList
                tasks={shown}
                statusColors={statusColors}
                greenDone={pinnedView}
                onOpen={goTo}
                onCycle={cycle}
                onReorder={applyOrder}
              />
            )}
          </div>
        </aside>
      )}
      <div className="ov-rail" style={open ? { right: width + 14 } : undefined}>
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

interface ListProps {
  tasks: PanelTask[];
  statusColors: Record<TaskStatus, string | null>;
  greenDone: boolean;
  onOpen: (t: PanelTask) => void;
  onCycle: (t: PanelTask) => void;
  onReorder: (ids: string[]) => void;
}

interface DragState {
  id: string;
  /** Смещение блока от исходного места (px). */
  dy: number;
  /** Индекс вставки в списке без перетаскиваемого блока. */
  to: number;
}

/** Список блоков с перетаскиванием (pointer events: работает и в WebView2, и под CDP). */
function BlockList({ tasks, statusColors, greenDone, onOpen, onCycle, onReorder }: ListProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const suppressClick = useRef(false);

  const onPointerDown = (e: React.PointerEvent, task: PanelTask) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".qp-status")) return;
    const startY = e.clientY;
    const ids = tasks.map((t) => t.id);
    // Середины блоков в исходном положении.
    const mids = ids.map((id) => {
      const r = refs.current.get(id)!.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const from = ids.indexOf(task.id);
    let active = false;
    let to = from;

    const calc = (y: number) => {
      // Индекс среди остальных блоков: сколько середин других блоков выше курсора.
      let n = 0;
      mids.forEach((m, i) => {
        if (i !== from && m < y) n++;
      });
      return n;
    };
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!active) {
        if (Math.abs(dy) < DRAG_THRESHOLD) return;
        active = true;
      }
      to = calc(mids[from] + dy);
      setDrag({ id: task.id, dy, to });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (active) {
        suppressClick.current = true;
        window.setTimeout(() => (suppressClick.current = false), 0);
        const rest = ids.filter((id) => id !== task.id);
        rest.splice(to, 0, task.id);
        setDrag(null);
        if (rest.some((id, i) => id !== ids[i])) onReorder(rest);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Индикатор вставки: линия перед блоком, который будет сразу после (или в конце).
  const others = drag ? tasks.filter((t) => t.id !== drag.id) : tasks;
  const indicatorBefore = drag ? (others[drag.to]?.id ?? null) : null;

  return (
    <ul className="qp-list">
      {tasks.map((t) => {
        const dragging = drag?.id === t.id;
        return (
          <li
            key={t.id}
            className={`qp-item${dragging ? " is-dragging" : ""}`}
            style={dragging ? { transform: `translateY(${drag!.dy}px)` } : undefined}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
          >
            {drag && !dragging && indicatorBefore === t.id && <div className="qp-drop" />}
            <Block
              task={t}
              statusColors={statusColors}
              greenDone={greenDone}
              onPointerDown={(e) => onPointerDown(e, t)}
              onOpen={() => {
                if (!suppressClick.current) onOpen(t);
              }}
              onCycle={() => onCycle(t)}
            />
          </li>
        );
      })}
      {drag && indicatorBefore === null && <li className="qp-drop is-end" />}
    </ul>
  );
}

interface BlockProps {
  task: PanelTask;
  statusColors: Record<TaskStatus, string | null>;
  greenDone: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
  onCycle: () => void;
}

function Block({ task, statusColors, greenDone, onPointerDown, onOpen, onCycle }: BlockProps) {
  const Icon = META[task.status].icon;
  // Заливка как у ноды: цвет статуса, иначе ручной цвет, иначе стандартный фон.
  // Готовая задача в закреплённом списке — зелёная (цвет «Готово» или палитра green).
  const color =
    statusColors[task.status] ?? (task.status === "done" && greenDone ? "green" : task.color);
  const style = fillStyle(color);
  const path = [task.spaceName, ...task.parents].join(" › ");
  return (
    <div
      className={`qp-block ov-st-${task.status}${style ? " has-fill" : ""}`}
      style={style}
      role="button"
      tabIndex={0}
      title="Перейти к задаче (перетащите, чтобы изменить порядок)"
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      {!style && <span className="qp-stripe" style={{ background: PALETTE[task.color ?? ""] ?? "var(--ov-st)" }} />}
      <div className="qp-path" title={path}>
        {path}
      </div>
      <div className="qp-main">
        <button
          className="qp-status"
          disabled={!NEXT_STATUS[task.status]}
          title={
            NEXT_STATUS[task.status]
              ? `${META[task.status].label} — сменить статус`
              : `${META[task.status].label} — меняется через ПКМ по задаче`
          }
          onClick={(e) => {
            e.stopPropagation();
            onCycle();
          }}
        >
          <Icon size={16} strokeWidth={2.2} />
        </button>
        <span className={`qp-text${task.title ? "" : " is-empty"}`}>{task.title || "Без названия"}</span>
      </div>
    </div>
  );
}
