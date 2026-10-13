import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Layers,
  Layers3,
  Network,
  Search,
  Settings,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { api } from "../api";
import { useGraph } from "../store/graph";
import { useMode } from "../store/mode";
import { useGraphSearch } from "../search/GraphSearch";
import { InlineInput } from "./InlineInput";
import { SettingsPanel } from "./SettingsPanel";
import { SpacesPanel } from "./SpacesPanel";

/**
 * Тонкий топбар (ТЗ §3): [Граф | База] [Пространства] [имя пространства] › крошки слоёв …
 * [поиск][настройки]. В режиме «База» вместо графовых элементов — имя vault.
 * Поиск по графу — M6.
 */
export function Topbar() {
  const mode = useMode((s) => s.mode);
  return (
    <header className="topbar">
      <ModeSwitch />
      {mode === "graph" ? <GraphBar /> : <KbBar />}
      <SettingsButton />
    </header>
  );
}

/** Сегмент «Граф | База» (Ctrl+1 / Ctrl+2). */
function ModeSwitch() {
  const mode = useMode((s) => s.mode);
  const setMode = useMode((s) => s.setMode);
  return (
    <div className="tb-mode" role="radiogroup" aria-label="Режим">
      <button
        type="button"
        role="radio"
        aria-checked={mode === "graph"}
        title="Граф (Ctrl+1)"
        onClick={() => setMode("graph")}
      >
        <Network size={13} />
        <span>Граф</span>
      </button>
      <button
        type="button"
        role="radio"
        className="is-kb"
        aria-checked={mode === "kb"}
        title="База знаний (Ctrl+2)"
        onClick={() => setMode("kb")}
      >
        <BookOpen size={13} />
        <span>База</span>
      </button>
    </div>
  );
}

/** Топбар режима «База»: имя папки vault (полный путь — в подсказке). */
function KbBar() {
  const [root, setRoot] = useState<string | null>(null);
  const tick = useMode((s) => s.vaultTick);
  useEffect(() => {
    let alive = true;
    void api
      .vaultInfo()
      .then((i) => alive && setRoot(i.root))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick]);
  const name = root ? root.split(/[\\/]/).filter(Boolean).pop() : "";
  return (
    <>
      <div className="tb-vault-name" title={root ?? ""}>
        {name}
      </div>
      <div className="tb-spacer" />
    </>
  );
}

function GraphBar() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const ready = useGraph((s) => s.phase === "ready");

  return (
    <>
      <div className="tb-spaces">
        <button
          ref={btnRef}
          type="button"
          className={open ? "tb-btn is-open" : "tb-btn"}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!ready}
          onClick={() => setOpen((v) => !v)}
        >
          <Layers size={14} />
          <span>Пространства</span>
          <ChevronDown size={13} />
        </button>
        {open && <SpacesPanel anchor={btnRef} onClose={close} />}
      </div>
      <SpaceNameField />
      <Crumbs />
      <div className="tb-spacer" />
      <NestedToggle />
      <button
        type="button"
        className="tb-icon"
        disabled={!ready}
        title="Поиск по графу (Ctrl+K)"
        onClick={() => useGraphSearch.getState().setOpen(true)}
      >
        <Search size={15} />
      </button>
    </>
  );
}

/** Название текущего пространства; двойной клик — переименование на месте. */
function SpaceNameField() {
  const space = useGraph((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const renameSpace = useGraph((s) => s.renameSpace);
  const inLayer = useGraph((s) => s.layers.length > 1);
  const exitTo = useGraph((s) => s.exitTo);
  const [editing, setEditing] = useState(false);

  if (!space) return <div className="tb-space-name is-empty">…</div>;
  if (editing) {
    return (
      <InlineInput
        key={space.id}
        className="tb-space-input"
        initial={space.name}
        onCommit={(name) => {
          setEditing(false);
          if (name !== space.name) void renameSpace(space.id, name);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div
      className={inLayer ? "tb-space-name is-link" : "tb-space-name"}
      title={inLayer ? "Клик — к основному полю, двойной клик — переименовать" : "Двойной клик — переименовать"}
      onClick={() => inLayer && void exitTo(0)}
      onDoubleClick={() => setEditing(true)}
    >
      {space.name}
    </div>
  );
}

/** Хлебные крошки слоёв (ТЗ §3, §4.5): › Задача A › Подзадача B. Клик — выход на этот уровень. */
function Crumbs() {
  const titles = useGraph(
    useShallow((s) =>
      s.layers.slice(1).map((cid, i) => {
        const owner = s.canvases[cid]?.canvas.ownerNode;
        const node = s.canvases[s.layers[i]]?.nodes.find((n) => n.id === owner);
        return node?.data.model.title || "Без названия";
      }),
    ),
  );
  const exitTo = useGraph((s) => s.exitTo);
  if (!titles.length) return <nav className="tb-crumbs" aria-label="Путь" />;
  return (
    <nav className="tb-crumbs" aria-label="Путь">
      {titles.map((title, i) => {
        const last = i === titles.length - 1;
        return (
          <span key={i} className="crumb-item">
            <ChevronRight size={13} className="crumb-sep" aria-hidden="true" />
            {last ? (
              <span className="crumb is-current" aria-current="page" title={title}>
                {title}
              </span>
            ) : (
              <button type="button" className="crumb" title={title} onClick={() => void exitTo(i + 1)}>
                {title}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Переключатель просвечивания вложенных уровней (ТЗ §4.5.1). */
function NestedToggle() {
  const show = useGraph((s) => s.showNested);
  const setShowNested = useGraph((s) => s.setShowNested);
  const ready = useGraph((s) => s.phase === "ready");
  return (
    <button
      type="button"
      className={show ? "tb-icon is-on" : "tb-icon"}
      aria-pressed={show}
      disabled={!ready}
      title={show ? "Скрыть вложенные уровни" : "Показывать вложенные уровни"}
      onClick={() => void setShowNested(!show)}
    >
      <Layers3 size={15} />
    </button>
  );
}

/** Шестерёнка → панель настроек (ТЗ §4.6.2). */
function SettingsButton() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const ready = useGraph((s) => s.phase === "ready");
  return (
    <div className="tb-settings">
      <button
        ref={btnRef}
        type="button"
        className={open ? "tb-icon is-open" : "tb-icon"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!ready}
        title="Настройки"
        onClick={() => setOpen((v) => !v)}
      >
        <Settings size={15} />
      </button>
      {open && <SettingsPanel anchor={btnRef} onClose={close} />}
    </div>
  );
}
