// Окна перестройки дерева (ТЗ §4.12.3): выбор судьбы подзадач при удалении
// задачи-родителя (с отдельным подтверждением) и выбор задачи для
// «Перенести в задачу…».

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { ArrowUpToLine, FolderInput, StickyNote, Trash2, Unlink } from "lucide-react";

import { api, type DeleteMode, type GraphNodeHit } from "../api";
import { fuzzy } from "../kb/fuzzy";
import { useGraph } from "../store/graph";
import { StatusIcon } from "./NodeParts";

export type DeleteChoice = "delete" | DeleteMode;

interface DeleteAsk {
  /** Заголовки удаляемых задач, у которых есть подзадачи. */
  titles: string[];
  /** Всего удаляемых нод (выделение) и вложенных элементов под ними. */
  count: number;
  nested: number;
  resolve: (choice: DeleteChoice | null) => void;
}

interface MoveAsk {
  ids: string[];
  /** Что переносим — для заголовка окна. */
  what: string;
}

/** «Разблокировать» задачу со стикерами (ТЗ §4.12.7): удалить их или оторвать. */
export type UnblockChoice = "delete" | "detach";

interface UnblockAsk {
  title: string;
  stickers: number;
  resolve: (choice: UnblockChoice | null) => void;
}

interface DialogState {
  unblockAsk: UnblockAsk | null;
  askUnblock: (info: Omit<UnblockAsk, "resolve">) => Promise<UnblockChoice | null>;
  deleteAsk: DeleteAsk | null;
  move: MoveAsk | null;
  /** Спросить, что делать с подзадачами; null — отмена. */
  askDelete: (info: Omit<DeleteAsk, "resolve">) => Promise<DeleteChoice | null>;
  openMove: (ids: string[], what: string) => void;
  closeMove: () => void;
}

export const useTreeDialogs = create<DialogState>()((set, get) => ({
  unblockAsk: null,
  askUnblock: (info) =>
    new Promise((resolve) => {
      get().unblockAsk?.resolve(null);
      set({
        unblockAsk: {
          ...info,
          resolve: (c) => {
            set({ unblockAsk: null });
            resolve(c);
          },
        },
      });
    }),
  deleteAsk: null,
  move: null,
  askDelete: (info) =>
    new Promise((resolve) => {
      get().deleteAsk?.resolve(null);
      set({
        deleteAsk: {
          ...info,
          resolve: (c) => {
            set({ deleteAsk: null });
            resolve(c);
          },
        },
      });
    }),
  openMove: (ids, what) => set({ move: { ids, what } }),
  closeMove: () => set({ move: null }),
}));

const CHOICES: { id: DeleteChoice; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: "delete",
    label: "Удалить подзадачи",
    hint: "Задача удаляется вместе со всеми вложенными уровнями",
    icon: <Trash2 size={15} />,
  },
  {
    id: "lift",
    label: "Перенести на уровень родителя",
    hint: "Подзадачи со своей вложенностью и стрелками между собой переезжают туда, где лежала задача, на свои места",
    icon: <ArrowUpToLine size={15} />,
  },
  {
    id: "orphan",
    label: "Не трогать",
    hint: "Слой подзадач остаётся как был, но без родителя — потом можно перенести его в другую задачу",
    icon: <Unlink size={15} />,
  },
];

function confirmText(a: DeleteAsk, c: DeleteChoice): string {
  const who = a.titles.length === 1 ? `«${a.titles[0]}»` : `задачи (${a.titles.length})`;
  const extra = a.count > a.titles.length ? ` и ещё ${a.count - a.titles.length} нод` : "";
  switch (c) {
    case "delete":
      return `Удалить ${who}${extra} вместе с вложенными элементами (${a.nested})?`;
    case "lift":
      return `Удалить ${who}${extra}? Подзадачи (${a.nested} с вложенными) переедут на уровень выше.`;
    case "orphan":
      return `Удалить ${who}${extra}? Слой подзадач останется без родителя.`;
  }
}

/** Удаление задачи с подзадачами: выбор → подтверждение. */
export function DeleteParentDialog() {
  const ask = useTreeDialogs((s) => s.deleteAsk);
  const [choice, setChoice] = useState<DeleteChoice | null>(null);
  useEffect(() => setChoice(null), [ask]);
  if (!ask) return null;
  const cancel = () => ask.resolve(null);
  return (
    <div
      className="gm-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (choice) setChoice(null);
          else cancel();
        }
        // Delete/Backspace — не до холста.
        e.stopPropagation();
      }}
    >
      <div className="gm-dialog" role="dialog" aria-label="Удаление задачи с подзадачами">
        {!choice ? (
          <>
            <div className="gm-title">
              {ask.titles.length === 1
                ? `У задачи «${ask.titles[0] || "Без названия"}» есть подзадачи`
                : `У удаляемых задач (${ask.titles.length}) есть подзадачи`}
            </div>
            <div className="gm-text">Что сделать с подзадачами ({ask.nested})?</div>
            <div className="gm-choices">
              {CHOICES.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  className={c.id === "delete" ? "gm-choice is-danger" : "gm-choice"}
                  autoFocus={i === 1}
                  onClick={() => setChoice(c.id)}
                >
                  {c.icon}
                  <span className="gm-choice-text">
                    <span className="gm-choice-label">{c.label}</span>
                    <span className="gm-choice-hint">{c.hint}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="gm-actions">
              <button type="button" className="gm-btn" onClick={cancel}>
                Отмена
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="gm-title">Подтверждение</div>
            <div className="gm-text">{confirmText(ask, choice)}</div>
            <div className="gm-actions">
              <button type="button" className="gm-btn" onClick={() => setChoice(null)}>
                Назад
              </button>
              <button type="button" className="gm-btn" onClick={cancel}>
                Отмена
              </button>
              <button
                type="button"
                className="gm-btn is-danger"
                autoFocus
                onClick={() => ask.resolve(choice)}
              >
                Удалить
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const LIMIT = 60;

/** «Перенести в задачу…»: поиск задачи текущего пространства. */
export function MovePicker() {
  const move = useTreeDialogs((s) => s.move);
  return move ? <MovePickerImpl move={move} /> : null;
}

function MovePickerImpl({ move }: { move: MoveAsk }) {
  const close = useTreeDialogs((s) => s.closeMove);
  const spaceId = useGraph((s) => s.activeSpaceId);
  const moveIntoTask = useGraph((s) => s.moveIntoTask);
  const [all, setAll] = useState<GraphNodeHit[] | null>(null);
  const [forbidden, setForbidden] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [hits, desc] = await Promise.all([
          api.listGraphNodes(),
          api.listDescendants(move.ids),
        ]);
        if (!alive) return;
        setAll(hits.filter((h) => h.spaceId === spaceId && h.kind === "task"));
        // Нельзя: сами переносимые ноды и их потомки (ТЗ §4.12.3).
        setForbidden(new Set([...move.ids, ...desc.map((d) => d.id)]));
      } catch (e) {
        useGraph.getState().showError(e);
        close();
      }
    })();
    return () => {
      alive = false;
    };
  }, [move, spaceId, close]);

  const results = useMemo(() => {
    const list = all ?? [];
    if (!q.trim()) return list.slice(0, LIMIT).map((hit) => ({ hit, score: 0 }));
    const out: { hit: GraphNodeHit; score: number }[] = [];
    for (const hit of list) {
      const m = fuzzy(q, hit.title) ?? fuzzy(q, [...hit.parents, hit.title].join(" › "));
      if (m) out.push({ hit, score: m.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, LIMIT);
  }, [all, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    if (forbidden.has(r.hit.id)) {
      useGraph
        .getState()
        .showError(
          move.ids.includes(r.hit.id)
            ? "нельзя перенести задачу в саму себя"
            : "нельзя перенести задачу в её же подзадачу",
        );
      return;
    }
    close();
    void moveIntoTask(move.ids, r.hit.id);
  };

  return (
    <div className="gs-backdrop gm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="gs-palette mp-palette" role="dialog" aria-label="Перенести в задачу">
        <div className="mp-head">
          <FolderInput size={14} />
          <span>Перенести {move.what} в задачу…</span>
        </div>
        <input
          autoFocus
          className="gs-input"
          placeholder="Найти задачу…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => (results.length ? (s + 1) % results.length : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => (results.length ? (s - 1 + results.length) % results.length : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel);
            }
          }}
        />
        <div ref={listRef} className="gs-list">
          {results.map((r, i) => {
            const bad = forbidden.has(r.hit.id);
            return (
              <div
                key={r.hit.id}
                className={`gs-item${i === sel ? " is-selected" : ""}${bad ? " is-disabled" : ""}`}
                title={bad ? "Нельзя: это переносимая задача или её подзадача" : undefined}
                onMouseMove={() => setSel(i)}
                // Фокус остаётся в поле поиска (в т.ч. после клика по недоступной задаче).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <span className={`gs-mark status-${r.hit.status ?? "todo"}`}>
                  <StatusIcon status={r.hit.status ?? "todo"} />
                </span>
                <div className="gs-text">
                  <div className="gs-title">{r.hit.title || "Без названия"}</div>
                  <div className="gs-path">{[r.hit.spaceName, ...r.hit.parents].join(" › ")}</div>
                </div>
              </div>
            );
          })}
          {all && !results.length && <div className="gs-empty">Ничего не найдено</div>}
          {!all && <div className="gs-empty">Загрузка…</div>}
        </div>
      </div>
    </div>
  );
}

/** «Разблокировать» задачу со стикерами (ТЗ §4.12.7): удалить стикеры или оторвать их. */
export function UnblockDialog() {
  const ask = useTreeDialogs((s) => s.unblockAsk);
  if (!ask) return null;
  const cancel = () => ask.resolve(null);
  const many = ask.stickers > 1;
  return (
    <div
      className="gm-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
        e.stopPropagation();
      }}
    >
      <div className="gm-dialog" role="dialog" aria-label="Разблокировать задачу">
        <div className="gm-title">Разблокировать «{ask.title || "Без названия"}»</div>
        <div className="gm-text">
          {many ? `На задаче ${ask.stickers} стикера-причины.` : "На задаче стикер-причина."} Что с {many ? "ними" : "ним"} сделать?
        </div>
        <div className="gm-choices">
          <button type="button" className="gm-choice is-danger" onClick={() => ask.resolve("delete")}>
            <Trash2 size={15} />
            <span className="gm-choice-text">
              <span className="gm-choice-label">{many ? "Удалить стикеры" : "Удалить стикер"}</span>
              <span className="gm-choice-hint">Причина больше не нужна</span>
            </span>
          </button>
          <button type="button" className="gm-choice" autoFocus onClick={() => ask.resolve("detach")}>
            <StickyNote size={15} />
            <span className="gm-choice-text">
              <span className="gm-choice-label">{many ? "Оторвать стикеры" : "Оторвать стикер"}</span>
              <span className="gm-choice-hint">
                Остаются задачами «Чужая» рядом, но больше не блокируют
              </span>
            </span>
          </button>
        </div>
        <div className="gm-actions">
          <button type="button" className="gm-btn" onClick={cancel}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
