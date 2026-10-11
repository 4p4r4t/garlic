// Поиск по базе (Ctrl+Shift+F): полнотекстовый, на стороне Rust; результаты
// по файлам со сниппетами, совпадения подсвечены. Клик — открыть на строке.
// При фильтре «только результаты» (ТЗ §4.11) — только по результатам задач
// (переключатель «везде»).

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";

import { api, type SearchHit } from "../api";
import { noteName, parentDir } from "./paths";
import { inResults, useResults } from "./results";
import { ScopeToggle } from "./ScopeToggle";
import { useKb } from "./store";

const DEBOUNCE_MS = 200;
const LIMIT = 200;
/** С фильтром результаты отбираются после поиска — запрашиваем больше файлов. */
const SCOPED_LIMIT = 2000;

/** Текст с подсвеченными вхождениями `q` (без учёта регистра). */
export function Highlighted({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={k++}>{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  return <>{parts}</>;
}

export function SearchView() {
  const query = useKb((s) => s.searchQuery);
  const setQuery = useKb((s) => s.setSearchQuery);
  const focusTick = useKb((s) => s.searchFocus);
  const notesVersion = useKb((s) => s.notes);
  const resultsOnly = useKb((s) => s.resultsOnly);
  const byPath = useResults((s) => s.byPath);
  const [everywhere, setEverywhere] = useState(false);
  const scoped = resultsOnly && !everywhere;
  const [allHits, setHits] = useState<SearchHit[] | null>(null);
  const hits = useMemo(
    () => (allHits && scoped ? allHits.filter((h) => inResults(h.path, byPath)).slice(0, LIMIT) : allHits),
    [allHits, scoped, byPath],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .vaultSearch(q, scoped ? SCOPED_LIMIT : LIMIT)
        .then((h) => alive && setHits(h))
        .catch(() => alive && setHits([]));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, notesVersion, scoped]);

  const total = hits?.reduce((n, h) => n + Math.max(h.total, h.nameMatch ? 1 : 0), 0) ?? 0;

  return (
    <div className="kb-search">
      <div className="kb-search-box">
        <Search size={14} className="kb-search-icon" />
        <input
          ref={inputRef}
          value={query}
          placeholder="Поиск по базе…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query && (
          <button type="button" className="kb-search-clear" title="Очистить" onClick={() => setQuery("")}>
            <X size={13} />
          </button>
        )}
      </div>
      {resultsOnly && (
        <div className="kb-search-scope">
          <ScopeToggle everywhere={everywhere} onChange={setEverywhere} />
        </div>
      )}
      {hits && (
        <div className="kb-search-summary">
          {hits.length
            ? `${total} совпадений в ${hits.length} файлах`
            : scoped
              ? "Среди результатов ничего не найдено"
              : "Ничего не найдено"}
        </div>
      )}
      <div className="kb-search-results">
        {hits?.map((h) => {
          const open = !collapsed.has(h.path);
          return (
            <div key={h.path} className="kb-search-file">
              <div
                className="kb-search-file-title"
                onClick={() => void useKb.getState().openNote(h.path)}
                title={h.path}
              >
                <button
                  type="button"
                  className="kb-search-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed((s) => {
                      const n = new Set(s);
                      if (n.has(h.path)) n.delete(h.path);
                      else n.add(h.path);
                      return n;
                    });
                  }}
                >
                  <ChevronRight size={13} className={open ? "kb-chevron is-open" : "kb-chevron"} />
                </button>
                <span className="kb-search-name">
                  <Highlighted text={noteName(h.path)} q={query} />
                </span>
                {parentDir(h.path) && <span className="kb-search-dir">{parentDir(h.path)}</span>}
                {h.total > 0 && <span className="kb-search-count">{h.total}</span>}
              </div>
              {open &&
                h.lines.map((l) => (
                  <div
                    key={l.line}
                    className="kb-search-match"
                    onClick={() => void useKb.getState().openNote(h.path, { reveal: { line: l.line } })}
                  >
                    <Highlighted text={l.text} q={query} />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
