// «Привязать существующее…» (ТЗ §4.10): нечёткий поиск по дереву базы знаний —
// заметки и/или папки. Модальное окно поверх графа (портал в body).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Folder, Home } from "lucide-react";

import { api } from "../api";
import { fuzzy } from "../kb/fuzzy";
import { baseName, flatten, noteName, parentDir } from "../kb/paths";

const LIMIT = 60;

export type PickerFilter = "any" | "notes" | "folders";

interface Props {
  title: string;
  filter: PickerFilter;
  /** Добавить корень vault первым пунктом (выбор папки по умолчанию). */
  includeRoot?: boolean;
  /** Текущая ссылка — отмечается. */
  current?: string | null;
  onPick: (path: string, isDir: boolean) => void;
  onClose: () => void;
}

interface Item {
  path: string;
  name: string;
  isDir: boolean;
  indices: number[];
  score: number;
}

function Marked({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : ch))}
    </>
  );
}

export function KbPicker({ title, filter, includeRoot, current, onPick, onClose }: Props) {
  const [entries, setEntries] = useState<{ path: string; isDir: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .vaultTree()
      .then((tree) => {
        if (!alive) return;
        const { notes, folders } = flatten(tree);
        const list = [
          ...(filter !== "notes" ? folders.map((path) => ({ path, isDir: true })) : []),
          ...(filter !== "folders" ? notes.map((path) => ({ path, isDir: false })) : []),
        ];
        setEntries(list);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [filter]);

  const results = useMemo<Item[]>(() => {
    if (!entries) return [];
    const nameOf = (e: { path: string; isDir: boolean }) => (e.isDir ? baseName(e.path) : noteName(e.path));
    const root: Item[] =
      includeRoot && !q.trim() ? [{ path: "", name: "Корень базы", isDir: true, indices: [], score: 0 }] : [];
    if (!q.trim()) {
      const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, "ru"));
      return [...root, ...sorted.slice(0, LIMIT).map((e) => ({ ...e, name: nameOf(e), indices: [], score: 0 }))];
    }
    const out: Item[] = [];
    for (const e of entries) {
      const name = nameOf(e);
      const byName = fuzzy(q, name);
      if (byName) {
        out.push({ ...e, name, indices: byName.indices, score: byName.score + 50 });
        continue;
      }
      const byPath = fuzzy(q, e.path);
      if (byPath) out.push({ ...e, name, indices: [], score: byPath.score });
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "ru"));
    return out.slice(0, LIMIT);
  }, [entries, q, includeRoot]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: number) => {
    const it = results[i];
    if (!it) return;
    onClose();
    onPick(it.path, it.isDir);
  };

  const empty =
    filter === "folders" ? "Нет папок" : filter === "notes" ? "Нет заметок" : "Нет заметок и папок";

  return createPortal(
    <div
      className="kbp-backdrop"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="kbp" role="dialog" aria-label={title}>
        <div className="kbp-title">{title}</div>
        <input
          autoFocus
          className="kbp-input"
          placeholder="Поиск по базе знаний…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
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
        <div ref={listRef} className="kbp-list">
          {results.map((r, i) => {
            const Icon = r.path === "" ? Home : r.isDir ? Folder : FileText;
            const dir = r.path ? parentDir(r.path) : "";
            return (
              <div
                key={r.path || "/"}
                className={`kbp-item${i === sel ? " is-selected" : ""}${r.path === current ? " is-current" : ""}`}
                onMouseMove={() => setSel(i)}
                onClick={() => choose(i)}
              >
                <Icon size={14} className="kbp-icon" />
                <span className="kbp-name">
                  <Marked text={r.name} indices={r.indices} />
                </span>
                {dir && <span className="kbp-path">{dir}</span>}
              </div>
            );
          })}
          {entries && !results.length && <div className="kbp-empty">{q.trim() ? "Ничего не найдено" : empty}</div>}
          {!entries && !error && <div className="kbp-empty">Загрузка…</div>}
          {error && <div className="kbp-empty is-error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
