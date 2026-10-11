import { useCallback, useRef, useState } from "react";
import { ChevronDown, Layers, Search, Settings } from "lucide-react";

import { useGraph } from "../store/graph";
import { InlineInput } from "./InlineInput";
import { SpacesPanel } from "./SpacesPanel";

/**
 * Тонкий топбар (ТЗ §3): [Пространства] [имя пространства] › крошки слоёв … [поиск][настройки].
 * Крошки слоёв — M3, поиск — M6, настройки — позже.
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
      {/* M3: хлебные крошки слоёв (› Задача A › Подзадача B) */}
      <nav className="tb-crumbs" aria-label="Путь" />
      <div className="tb-spacer" />
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
      className="tb-space-name"
      title="Двойной клик — переименовать"
      onDoubleClick={() => setEditing(true)}
    >
      {space.name}
    </div>
  );
}
