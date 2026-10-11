// Быстрый переход Ctrl+O: нечёткий поиск заметки по имени (и пути).
// Enter — открыть, Ctrl+Enter — в новой вкладке, Shift+Enter — создать заметку
// с введённым именем (если такой нет — Enter тоже создаёт).

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FilePlus2 } from "lucide-react";

import { fuzzy } from "./fuzzy";
import { noteName, parentDir } from "./paths";
import { useKb } from "./store";

const LIMIT = 50;

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

export function QuickSwitcher() {
  const notes = useKb((s) => s.notes);
  const close = () => useKb.getState().setSwitcherOpen(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!q.trim()) {
      // Без запроса — недавние (открытые вкладки), потом остальные по имени.
      const open = useKb.getState().tabs.map((t) => t.path);
      const rest = notes.filter((n) => !open.includes(n));
      return [...open.filter((p) => notes.includes(p)), ...rest]
        .slice(0, LIMIT)
        .map((path) => ({ path, name: noteName(path), indices: [] as number[], score: 0 }));
    }
    const out: { path: string; name: string; indices: number[]; score: number }[] = [];
    for (const path of notes) {
      const name = noteName(path);
      const byName = fuzzy(q, name);
      if (byName) {
        out.push({ path, name, indices: byName.indices, score: byName.score + 50 });
        continue;
      }
      const byPath = fuzzy(q, path);
      if (byPath) out.push({ path, name, indices: [], score: byPath.score });
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, LIMIT);
  }, [q, notes]);

  const exact = results.some((r) => r.name.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;
  const count = results.length + (canCreate ? 1 : 0);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const create = () => {
    close();
    void useKb.getState().createNote("", q.trim());
  };
  const choose = (i: number, newTab: boolean) => {
    if (i >= results.length) return create();
    close();
    void useKb.getState().openNote(results[i].path, { newTab });
  };

  return (
    <div className="kb-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="kb-switcher" role="dialog" aria-label="Быстрый переход">
        <input
          autoFocus
          className="kb-switcher-input"
          placeholder="Найти или создать заметку…"
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
              setSel((s) => (count ? (s + 1) % count : 0));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setSel((s) => (count ? (s - 1 + count) % count : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey && q.trim()) create();
              else if (count) choose(sel, e.ctrlKey || e.metaKey);
            }
          }}
        />
        <div ref={listRef} className="kb-switcher-list">
          {results.map((r, i) => (
            <div
              key={r.path}
              className={i === sel ? "kb-switcher-item is-selected" : "kb-switcher-item"}
              onMouseMove={() => setSel(i)}
              onClick={(e) => choose(i, e.ctrlKey || e.metaKey)}
            >
              <div className="kb-switcher-name">
                <Marked text={r.name} indices={r.indices} />
              </div>
              {parentDir(r.path) && <div className="kb-switcher-path">{parentDir(r.path)}</div>}
            </div>
          ))}
          {canCreate && (
            <div
              className={sel === results.length ? "kb-switcher-item is-selected is-create" : "kb-switcher-item is-create"}
              onMouseMove={() => setSel(results.length)}
              onClick={create}
            >
              <FilePlus2 size={14} />
              <span>
                Создать «{q.trim()}»
              </span>
            </div>
          )}
          {!count && <div className="kb-switcher-empty">Нет заметок</div>}
        </div>
        <div className="kb-switcher-hints">
          <span>
            <kbd>↑↓</kbd> выбрать
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{" "}
            открыть
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>↵</kbd> в новой вкладке
          </span>
          <span>
            <kbd>Shift</kbd>+<kbd>↵</kbd> создать
          </span>
          <span>
            <kbd>Esc</kbd> закрыть
          </span>
        </div>
      </div>
    </div>
  );
}
