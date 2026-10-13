// Поиск по графу (M6b): палитра Ctrl+K / лупа в топбаре. Ищет задачи и заметки
// всех пространств и уровней, нечётко по названию; Enter / клик — переключить
// пространство и провалиться к ноде с камерой (`revealGraphNode`).

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { StickyNote } from "lucide-react";

import { api, type GraphNodeHit } from "../api";
import { StatusIcon, STATUS_META } from "../canvas/NodeParts";
import { fuzzy } from "../kb/fuzzy";
import { useGraph } from "../store/graph";
import { revealGraphNode } from "../store/mode";

const LIMIT = 50;

interface SearchState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useGraphSearch = create<SearchState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Путь результата: `Пространство › Задача A › …` (без самой ноды). */
export const hitPath = (h: Pick<GraphNodeHit, "spaceName" | "parents">) =>
  [h.spaceName, ...h.parents].join(" › ");

interface Scored {
  hit: GraphNodeHit;
  indices: number[];
  score: number;
}

/** Нечёткий отбор: по названию (приоритет), иначе по полному пути. */
export function searchHits(hits: GraphNodeHit[], q: string, activeSpace: string | null): Scored[] {
  if (!q.trim()) {
    return hits
      .map((hit, i) => ({ hit, indices: [] as number[], score: (hit.spaceId === activeSpace ? 1000 : 0) - i }))
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT);
  }
  const out: Scored[] = [];
  for (const hit of hits) {
    const byTitle = fuzzy(q, hit.title);
    if (byTitle) {
      out.push({
        hit,
        indices: byTitle.indices,
        score: byTitle.score + 50 + (hit.spaceId === activeSpace ? 5 : 0),
      });
      continue;
    }
    const byPath = fuzzy(q, `${hitPath(hit)} › ${hit.title}`);
    if (byPath) out.push({ hit, indices: [], score: byPath.score });
  }
  out.sort((a, b) => b.score - a.score || a.hit.title.localeCompare(b.hit.title));
  return out.slice(0, LIMIT);
}

function Marked({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const out: React.ReactNode[] = [];
  let buf = "";
  let on = false;
  const flush = (k: number) => {
    if (!buf) return;
    out.push(on ? <b key={k}>{buf}</b> : buf);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

/** Ctrl+K (в режиме «Граф»). Монтируется один раз в App. */
export function GraphSearchHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.code !== "KeyK") return;
      if (document.querySelector(".kb-host:not(.is-hidden)")) return;
      e.preventDefault();
      const s = useGraphSearch.getState();
      s.setOpen(!s.open);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return null;
}

export function GraphSearch() {
  const open = useGraphSearch((s) => s.open);
  return open ? <Palette /> : null;
}

function Palette() {
  const close = () => useGraphSearch.getState().setOpen(false);
  const activeSpace = useGraph((s) => s.activeSpaceId);
  const [all, setAll] = useState<GraphNodeHit[] | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .listGraphNodes()
      .then((l) => alive && setAll(l))
      .catch((e) => {
        useGraph.getState().showError(e);
        close();
      });
    return () => {
      alive = false;
    };
  }, []);

  const results = useMemo(() => searchHits(all ?? [], q, activeSpace), [all, q, activeSpace]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    close();
    void revealGraphNode(r.hit);
  };

  return (
    <div className="gs-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="gs-palette" role="dialog" aria-label="Поиск по графу">
        <input
          autoFocus
          className="gs-input"
          placeholder="Найти задачу или заметку…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setSel((s) => (results.length ? (s + 1) % results.length : 0));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setSel((s) => (results.length ? (s - 1 + results.length) % results.length : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel);
            }
          }}
        />
        <div ref={listRef} className="gs-list">
          {results.map((r, i) => (
            <div
              key={r.hit.id}
              className={i === sel ? "gs-item is-selected" : "gs-item"}
              onMouseMove={() => setSel(i)}
              onClick={() => choose(i)}
            >
              <span
                className={`gs-mark${r.hit.status ? ` status-${r.hit.status}` : " is-note"}`}
                title={r.hit.status ? STATUS_META[r.hit.status].label : "Заметка"}
              >
                {r.hit.status ? <StatusIcon status={r.hit.status} /> : <StickyNote size={15} />}
              </span>
              <div className="gs-text">
                <div className="gs-title">
                  {r.hit.title ? <Marked text={r.hit.title} indices={r.indices} /> : "Без названия"}
                </div>
                <div className="gs-path">{hitPath(r.hit)}</div>
              </div>
            </div>
          ))}
          {all && !results.length && <div className="gs-empty">Ничего не найдено</div>}
          {!all && <div className="gs-empty">Загрузка…</div>}
        </div>
        <div className="gs-hints">
          <span>
            <kbd>↑↓</kbd> выбрать
          </span>
          <span>
            <kbd>↵</kbd> перейти
          </span>
          <span>
            <kbd>Esc</kbd> закрыть
          </span>
        </div>
      </div>
    </div>
  );
}
