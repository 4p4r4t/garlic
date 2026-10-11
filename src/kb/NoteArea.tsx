// Центр режима «База»: вкладки, заголовок заметки (= имя файла, переименовывает
// файл), редактор Live Preview / режим чтения, баннеры конфликта и удаления.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, ChevronRight, Pencil, Plus, X } from "lucide-react";

import { openExternal } from "./editor/setup";
import { noteName, parentDir } from "./paths";
import { highlightIn, renderMarkdown, taskLines } from "./reading";
import { docs, useDocMeta, useKb, type Tab } from "./store";

export function TabBar() {
  const tabs = useKb((s) => s.tabs);
  const activeId = useKb((s) => s.activeId);
  const meta = useKb((s) => s.meta);
  const kb = useKb.getState;
  return (
    <div className="kb-tabbar" role="tablist">
      <div className="kb-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={t.id === activeId ? "kb-tab is-active" : "kb-tab"}
            title={t.path}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void kb().closeTab(t.id);
              }
            }}
            onClick={() => kb().activate(t.id)}
          >
            <span className="kb-tab-title">{noteName(t.path)}</span>
            {meta[t.id]?.dirty && <span className="kb-tab-dirty" title="Есть несохранённые изменения" />}
            <button
              type="button"
              className="kb-tab-close"
              title="Закрыть (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                void kb().closeTab(t.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="kb-tab-new"
          title="Открыть заметку (Ctrl+O)"
          onClick={() => kb().setSwitcherOpen(true)}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

export function NoteArea() {
  const tabs = useKb((s) => s.tabs);
  const activeId = useKb((s) => s.activeId);
  if (!tabs.length) return <EmptyState />;
  return (
    <div className="kb-panes">
      {tabs.map((t) => (
        <NotePane key={t.id} tab={t} active={t.id === activeId} />
      ))}
    </div>
  );
}

function EmptyState() {
  const kb = useKb.getState;
  return (
    <div className="kb-empty-state">
      <div className="kb-empty-title">Нет открытых заметок</div>
      <button type="button" onClick={() => void kb().createNote("")}>
        Создать заметку <kbd>Ctrl+N</kbd>
      </button>
      <button type="button" onClick={() => kb().setSwitcherOpen(true)}>
        Перейти к заметке <kbd>Ctrl+O</kbd>
      </button>
      <button type="button" onClick={() => kb().focusSearch()}>
        Поиск по базе <kbd>Ctrl+Shift+F</kbd>
      </button>
    </div>
  );
}

function NotePane({ tab, active }: { tab: Tab; active: boolean }) {
  const meta = useDocMeta(tab.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dir = parentDir(tab.path);
  const kb = useKb.getState;

  return (
    <div className={active ? "kb-pane is-active" : "kb-pane"} aria-hidden={!active}>
      <div className="kb-view-header">
        <div className="kb-view-crumbs" title={tab.path}>
          {dir &&
            dir.split("/").map((part, i) => (
              <span key={i} className="kb-crumb-part">
                <span
                  className="kb-crumb"
                  onClick={() => kb().revealInTree(dir.split("/").slice(0, i + 1).join("/"))}
                >
                  {part}
                </span>
                <ChevronRight size={12} className="kb-crumb-sep" />
              </span>
            ))}
          <span className="kb-crumb is-current" onClick={() => kb().revealInTree(tab.path)}>
            {noteName(tab.path)}
          </span>
        </div>
        <div className="kb-view-actions">
          <button
            type="button"
            className="kb-view-action"
            title={tab.reading ? "Редактировать (Ctrl+E)" : "Режим чтения (Ctrl+E)"}
            onClick={() => kb().toggleReading(tab.id)}
          >
            {tab.reading ? <Pencil size={16} /> : <BookOpen size={16} />}
          </button>
        </div>
      </div>
      {meta.conflict && <ConflictBanner id={tab.id} />}
      {meta.missing && <MissingBanner id={tab.id} />}
      <div ref={scrollRef} className="kb-view-content">
        {meta.error ? (
          <div className="kb-load-error">Не удалось открыть: {meta.error}</div>
        ) : (
          <>
            <InlineTitle tab={tab} />
            {tab.reading ? (
              <ReadingView tab={tab} version={meta.version} />
            ) : (
              <EditorHost id={tab.id} loaded={meta.loaded} active={active} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConflictBanner({ id }: { id: string }) {
  return (
    <div className="kb-banner">
      <span>Файл изменён снаружи, а здесь есть несохранённые правки.</span>
      <button type="button" onClick={() => void docs.get(id)?.resolveConflict(true)}>
        Оставить моё
      </button>
      <button type="button" onClick={() => void docs.get(id)?.resolveConflict(false)}>
        Загрузить с диска
      </button>
    </div>
  );
}

function MissingBanner({ id }: { id: string }) {
  return (
    <div className="kb-banner">
      <span>Файл удалён или перемещён снаружи. Несохранённые правки остались здесь.</span>
      <button type="button" onClick={() => void docs.get(id)?.save()}>
        Сохранить заново
      </button>
      <button type="button" onClick={() => void useKb.getState().closeTab(id)}>
        Закрыть
      </button>
    </div>
  );
}

/** Заголовок над текстом = имя файла; Enter/уход фокуса — переименование. */
function InlineTitle({ tab }: { tab: Tab }) {
  const name = noteName(tab.path);
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusMe = useKb((s) => s.titleFocus === tab.id);

  useEffect(() => setValue(name), [name]);

  useEffect(() => {
    if (!focusMe) return;
    useKb.getState().clearTitleFocus();
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
  }, [focusMe]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const commit = async () => {
    const v = value.replace(/\s+/g, " ").trim();
    if (!v || v === name) {
      setValue(name);
      return;
    }
    const to = await useKb.getState().rename(tab.path, v);
    if (!to) setValue(name);
  };

  return (
    <textarea
      ref={ref}
      className="kb-inline-title"
      rows={1}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit().then(() => docs.get(tab.id)?.view?.focus());
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setValue(name);
          docs.get(tab.id)?.view?.focus();
        }
      }}
      onBlur={() => void commit()}
    />
  );
}

/** Монтирует EditorView вкладки (он живёт в NoteDoc и переживает перемонтирование). */
function EditorHost({ id, loaded, active }: { id: string; loaded: boolean; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    const view = docs.get(id)?.view;
    if (!host || !view) return;
    host.appendChild(view.dom);
    view.requestMeasure();
    return () => {
      if (view.dom.parentNode === host) host.removeChild(view.dom);
    };
  }, [id, loaded]);
  useEffect(() => {
    if (active) docs.get(id)?.view?.requestMeasure();
  }, [active, id]);
  return <div ref={ref} className="kb-editor-host" />;
}

/** Режим чтения: отрисованный markdown; ссылки и чекбоксы работают. */
function ReadingView({ tab, version }: { tab: Tab; version: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const notes = useKb((s) => s.notes);

  useEffect(() => {
    const el = ref.current;
    const doc = docs.get(tab.id);
    if (!el || !doc) return;
    el.innerHTML = renderMarkdown(doc.text, notes, tab.path);
    el.querySelectorAll<HTMLInputElement>("input.rd-task").forEach((box, i) => {
      box.dataset.task = String(i);
    });
    void highlightIn(el);
  }, [tab.id, tab.path, version, notes]);

  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const box = t.closest<HTMLInputElement>("input.rd-task");
    if (box) {
      const doc = docs.get(tab.id);
      const view = doc?.view;
      const idx = Number(box.dataset.task);
      if (!view || Number.isNaN(idx)) return;
      const lineNo = taskLines(view.state.doc.toString())[idx];
      if (lineNo == null) return;
      const line = view.state.doc.line(lineNo + 1);
      const m = /\[( |x|X)\]/.exec(line.text);
      if (!m) return;
      const at = line.from + m.index + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[1] === " " ? "x" : " " } });
      return;
    }
    const a = t.closest<HTMLElement>("a");
    if (!a) return;
    e.preventDefault();
    const newTab = e.ctrlKey || e.metaKey;
    if (a.dataset.href) void openExternal(a.dataset.href);
    else if (a.dataset.target != null) void useKb.getState().openLink(a.dataset.target, tab.path, newTab);
  };

  return <div ref={ref} className="kb-reading markdown-rendered" onClick={onClick} />;
}
