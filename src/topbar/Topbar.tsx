import { useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Layers, Layers3, Search, Settings } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { useGraph } from "../store/graph";
import { InlineInput } from "./InlineInput";
import { SpacesPanel } from "./SpacesPanel";

/**
 * Тонкий топбар (ТЗ §3): [Пространства] [имя пространства] › крошки слоёв … [поиск][настройки].
 * Поиск — M6, настройки — позже.
 */
export function Topbar() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const ready = useGraph((s) => s.phase === "ready");

  return (
    <header className="topbar">
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
      <button type="button" className="tb-icon" disabled title="Поиск (скоро)">
        <Search size={15} />
      </button>
      <button type="button" className="tb-icon" disabled title="Настройки (скоро)">
        <Settings size={15} />
      </button>
    </header>
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
