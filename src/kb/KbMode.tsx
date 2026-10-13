// Режим «База» (ТЗ §4.10) — раскладка в стиле Obsidian:
//   лента │ левая панель (проводник / поиск) │ вкладки + заметка │ правая панель.
// Грузится лениво (отдельный чанк с CodeMirror) и после первого входа остаётся
// смонтированным: вкладки, курсоры, история правок переживают переход в граф.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { FileSearch, Files, PanelLeft, PanelRight, Search } from "lucide-react";

import { LINKS_EVENT, VAULT_EVENT, type RelinkReport, type VaultEvent } from "../api";
import { useGraph } from "../store/graph";
import { useMode } from "../store/mode";
import { Explorer } from "./Explorer";
import { NoteArea, TabBar } from "./NoteArea";
import { showNotice } from "./notice";
import { QuickSwitcher } from "./QuickSwitcher";
import { RightPanel } from "./RightPanel";
import { inResults, useResults } from "./results";
import { SearchView } from "./SearchView";
import { docs, flushAllDocs, useKb } from "./store";
import "./kb.css";

export default function KbMode({ active }: { active: boolean }) {
  const ready = useKb((s) => s.ready);
  const leftOpen = useKb((s) => s.leftOpen);
  const rightOpen = useKb((s) => s.rightOpen);
  const leftWidth = useKb((s) => s.leftWidth);
  const rightWidth = useKb((s) => s.rightWidth);
  const leftView = useKb((s) => s.leftView);
  const switcherOpen = useKb((s) => s.switcherOpen);
  const vaultTick = useMode((s) => s.vaultTick);
  const kbRequest = useMode((s) => s.kbRequest);

  useEffect(() => {
    void useKb.getState().init();
  }, []);

  // Сменили папку vault в настройках.
  const firstTick = useRef(vaultTick);
  useEffect(() => {
    if (vaultTick !== firstTick.current) void useKb.getState().resetVault();
  }, [vaultTick]);

  // События watcher'а.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<VaultEvent[]>(VAULT_EVENT, (e) => useKb.getState().applyVaultEvents(e.payload)).then(
      (fn) => {
        if (cancelled) fn();
        else off = fn;
      },
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Ссылки переписаны при переименовании (M6c): открытые вкладки этих заметок
  // перечитываются (чистые — минимальной правкой, «грязные» — через баннер конфликта),
  // пользователю — короткое уведомление со счётом.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<RelinkReport>(LINKS_EVENT, (e) => {
      const { links, files } = e.payload;
      const kb = useKb.getState();
      for (const t of kb.tabs) if (files.includes(t.path)) void docs.get(t.id)?.external();
      showNotice(`Обновлено ссылок: ${links} (заметок: ${files.length})`);
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Фильтр «только результаты» (ТЗ §4.11): список результатов живой — пока
  // фильтр включён, перечитывается при смене дерева vault (watcher, действия в
  // «Базе»), кэша графа (ссылки, статусы, удаление задач, пространства) и при
  // входе в режим.
  useEffect(() => {
    const refresh = () => {
      if (useKb.getState().resultsOnly) useResults.getState().refresh();
    };
    const offKb = useKb.subscribe((s, p) => {
      if (s.resultsOnly && !p.resultsOnly) void useResults.getState().load();
      else if (s.tree !== p.tree) refresh();
    });
    const offGraph = useGraph.subscribe((s, p) => {
      if (s.canvases !== p.canvases || s.subtree !== p.subtree || s.spaces !== p.spaces) refresh();
    });
    if (useKb.getState().resultsOnly) void useResults.getState().load();
    return () => {
      offKb();
      offGraph();
    };
  }, []);
  useEffect(() => {
    if (active && useKb.getState().resultsOnly) void useResults.getState().load();
  }, [active]);

  // Запросы из графа (M5.2): открыть заметку / показать папку.
  useEffect(() => {
    if (!ready || !kbRequest) return;
    const req = useMode.getState().takeKbRequest();
    if (!req) return;
    const kb = useKb.getState();
    if (req.kind === "open") {
      void kb.openNote(req.path, { newTab: req.newTab });
      return;
    }
    // Папка не из результатов под фильтром не видна — фильтр снимается.
    if (kb.resultsOnly && !inResults(req.path, useResults.getState().byPath)) kb.setResultsOnly(false);
    kb.revealInTree(req.path);
  }, [ready, kbRequest]);

  // Уход из режима / закрытие окна — сохранить несохранённое.
  useEffect(() => {
    if (!active) void flushAllDocs();
  }, [active]);
  useEffect(() => {
    const onHide = () => void flushAllDocs();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("blur", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("blur", onHide);
    };
  }, []);

  // Горячие клавиши «Базы» — только в этом режиме.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const kb = useKb.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const k = e.code;
      if (k === "KeyO" && !e.shiftKey) {
        e.preventDefault();
        kb.setSwitcherOpen(!kb.switcherOpen);
      } else if (k === "KeyF" && e.shiftKey) {
        e.preventDefault();
        kb.focusSearch();
      } else if (k === "KeyN" && !e.shiftKey) {
        e.preventDefault();
        const t = kb.tabs.find((x) => x.id === kb.activeId);
        void kb.createNote(t ? t.path.split("/").slice(0, -1).join("/") : "");
      } else if (k === "KeyW" && !e.shiftKey) {
        e.preventDefault();
        if (kb.activeId) void kb.closeTab(kb.activeId);
      } else if (k === "KeyE" && !e.shiftKey) {
        e.preventDefault();
        kb.toggleReading();
      } else if (k === "KeyS" && !e.shiftKey) {
        e.preventDefault();
        if (kb.activeId) void docs.get(kb.activeId)?.save();
      } else if (k === "Tab") {
        e.preventDefault();
        const i = kb.tabs.findIndex((x) => x.id === kb.activeId);
        const n = kb.tabs.length;
        if (n > 1) kb.activate(kb.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  if (!ready) return <div className="kb"><div className="kb-loading">Загрузка…</div></div>;

  return (
    <div className="kb">
      <Ribbon />
      {leftOpen && (
        <aside className="kb-left" style={{ width: leftWidth }}>
          <div className="kb-nav-header is-tabs">
            <button
              type="button"
              className={leftView === "files" ? "kb-nav-btn is-active" : "kb-nav-btn"}
              title="Файлы"
              onClick={() => useKb.getState().setLeftView("files")}
            >
              <Files size={16} />
            </button>
            <button
              type="button"
              className={leftView === "search" ? "kb-nav-btn is-active" : "kb-nav-btn"}
              title="Поиск (Ctrl+Shift+F)"
              onClick={() => useKb.getState().focusSearch()}
            >
              <Search size={16} />
            </button>
          </div>
          {leftView === "files" ? <Explorer /> : <SearchView />}
        </aside>
      )}
      {leftOpen && <Resizer side="left" />}
      <section className="kb-main">
        <TabBar />
        <NoteArea />
      </section>
      {rightOpen && <Resizer side="right" />}
      {rightOpen && (
        <aside className="kb-right" style={{ width: rightWidth }}>
          <RightPanel />
        </aside>
      )}
      <button
        type="button"
        className="kb-right-toggle"
        title={rightOpen ? "Скрыть правую панель" : "Показать правую панель"}
        onClick={() => useKb.getState().setRightOpen(!rightOpen)}
      >
        <PanelRight size={16} />
      </button>
      {switcherOpen && <QuickSwitcher />}
    </div>
  );
}

function Ribbon() {
  const leftOpen = useKb((s) => s.leftOpen);
  const kb = useKb.getState;
  return (
    <nav className="kb-ribbon" aria-label="Лента">
      <button
        type="button"
        className="kb-ribbon-btn"
        title={leftOpen ? "Скрыть левую панель" : "Показать левую панель"}
        onClick={() => kb().setLeftOpen(!leftOpen)}
      >
        <PanelLeft size={18} />
      </button>
      <div className="kb-ribbon-sep" />
      <button
        type="button"
        className="kb-ribbon-btn"
        title="Проводник"
        onClick={() => {
          if (kb().leftOpen && kb().leftView === "files") kb().setLeftOpen(false);
          else kb().setLeftView("files");
        }}
      >
        <Files size={18} />
      </button>
      <button type="button" className="kb-ribbon-btn" title="Поиск (Ctrl+Shift+F)" onClick={() => kb().focusSearch()}>
        <Search size={18} />
      </button>
      <button
        type="button"
        className="kb-ribbon-btn"
        title="Быстрый переход (Ctrl+O)"
        onClick={() => kb().setSwitcherOpen(true)}
      >
        <FileSearch size={18} />
      </button>
    </nav>
  );
}

/** Перетаскиваемая граница панели; двойной клик — свернуть. */
function Resizer({ side }: { side: "left" | "right" }) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const kb = useKb.getState();
    const startX = e.clientX;
    const start = side === "left" ? kb.leftWidth : kb.rightWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-dragging");
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (side === "left") useKb.getState().setLeftWidth(start + dx);
      else useKb.getState().setRightWidth(start - dx);
    };
    const up = () => {
      el.classList.remove("is-dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div
      className={`kb-resizer is-${side}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        const kb = useKb.getState();
        if (side === "left") kb.setLeftOpen(false);
        else kb.setRightOpen(false);
      }}
    />
  );
}
