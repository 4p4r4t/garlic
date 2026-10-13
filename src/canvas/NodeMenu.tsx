import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Ban, FolderInput, Layers, ListTree, Palette, Trash2 } from "lucide-react";

import type { NodeModel } from "../api";
import { PALETTE } from "./palette";

interface Props {
  model: NodeModel;
  /** Экранный прямоугольник ноды на момент открытия меню. */
  anchor: DOMRect;
  onColor: (color: string | null) => void;
  onSubtasks: () => void;
  /** «Выделить с подзадачами» (ТЗ §4.12.2), только у задачи. */
  onSelectNested: () => void;
  /** «Перенести в задачу…» (ТЗ §4.12.3): эту ноду или все выделенные. */
  onMoveTo: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const GAP = 8;
const EDGE = 4;

/**
 * Контекстное меню ноды (ТЗ §4.4): компактная горизонтальная полоса иконок над нодой.
 * Закрывается по Esc / клику мимо / колесу (пан и драг закрывают его из Canvas).
 */
export function NodeMenu({
  model,
  anchor,
  onColor,
  onSubtasks,
  onSelectNested,
  onMoveTo,
  onDelete,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });

  // Над нодой, по центру; если сверху нет места — под ней. Не вылезаем за края окна.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const center = anchor.left + anchor.width / 2;
    const left = Math.max(EDGE, Math.min(center - width / 2, window.innerWidth - width - EDGE));
    const above = anchor.top - GAP - height >= EDGE;
    setStyle(
      above
        ? { left, bottom: window.innerHeight - anchor.top + GAP }
        : { left, top: Math.min(anchor.bottom + GAP, window.innerHeight - height - EDGE) },
    );
  }, [anchor, paletteOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="node-menu"
      role="menu"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      {paletteOpen && (
        <div className="node-menu-palette" role="group" aria-label="Цвет">
          {Object.entries(PALETTE).map(([key, hex]) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={model.color === key}
              className={`swatch${model.color === key ? " is-active" : ""}`}
              style={{ background: hex }}
              title={key}
              onClick={() => onColor(key)}
            />
          ))}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={model.color == null}
            className={`swatch swatch-reset${model.color == null ? " is-active" : ""}`}
            title="Сбросить цвет"
            onClick={() => onColor(null)}
          >
            <Ban size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      <div className="node-menu-bar">
        <button
          type="button"
          role="menuitem"
          className={`nm-btn${paletteOpen ? " is-on" : ""}`}
          title="Цвет"
          aria-label="Цвет"
          aria-expanded={paletteOpen}
          onClick={() => setPaletteOpen((v) => !v)}
        >
          <Palette size={16} strokeWidth={2} />
        </button>
        {model.kind === "task" && (
          <button
            type="button"
            role="menuitem"
            className="nm-btn"
            title="Подзадачи"
            aria-label="Подзадачи"
            onClick={onSubtasks}
          >
            <Layers size={16} strokeWidth={2} />
          </button>
        )}
        {model.kind === "task" && (
          <button
            type="button"
            role="menuitem"
            className="nm-btn"
            title="Выделить с подзадачами (Alt+клик)"
            aria-label="Выделить с подзадачами"
            onClick={onSelectNested}
          >
            <ListTree size={16} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className="nm-btn"
          title="Перенести в задачу…"
          aria-label="Перенести в задачу…"
          onClick={onMoveTo}
        >
          <FolderInput size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          role="menuitem"
          className="nm-btn is-danger"
          title="Удалить"
          aria-label="Удалить"
          onClick={onDelete}
        >
          <Trash2 size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
