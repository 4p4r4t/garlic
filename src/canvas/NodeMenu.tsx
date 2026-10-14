import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Ban, CircleDashed, FolderInput, Layers, ListTree, Lock, LockOpen, Palette, Trash2 } from "lucide-react";

import type { NodeModel, TaskStatus } from "../api";
import { StatusIcon, STATUS_META } from "./NodeParts";
import { PALETTE } from "./palette";

/** Статусы подменю «Статус» (ТЗ §4.12.7): «Заблокирована» — только «Заблокировать…». */
const MENU_STATUSES: TaskStatus[] = ["todo", "in_progress", "done", "foreign"];

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
  /** Подменю «Статус» (ТЗ §4.12.7). */
  onStatus: (status: TaskStatus) => void;
  /** «Заблокировать…»: причина → стикер «Чужая». */
  onBlock: (reason: string) => void;
  /** «Разблокировать». */
  onUnblock: () => void;
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
  onStatus,
  onBlock,
  onUnblock,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<"palette" | "status" | "block" | null>(null);
  const paletteOpen = panel === "palette";
  const setPaletteOpen = (fn: (v: boolean) => boolean) => setPanel(fn(paletteOpen) ? "palette" : null);
  const [reason, setReason] = useState("");
  const blocked = model.status === "blocked";
  const sticker = !!model.stickerOf;
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
  }, [anchor, panel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc в поле причины — назад к подменю, а не закрыть всё.
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) onClose();
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
      {panel === "status" && (
        <div className="node-menu-status" role="group" aria-label="Статус">
          {MENU_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              role="menuitemradio"
              aria-checked={model.status === st}
              className={`nm-status status-${st}${model.status === st ? " is-active" : ""}`}
              disabled={blocked || model.status === st}
              title={blocked ? "Задача заблокирована — сначала разблокируйте" : STATUS_META[st].label}
              onClick={() => onStatus(st)}
            >
              <StatusIcon status={st} />
              <span>{STATUS_META[st].label}</span>
            </button>
          ))}
          <span className="nm-sep" aria-hidden="true" />
          {!sticker && (
            <button
              type="button"
              role="menuitem"
              className="nm-status status-blocked"
              title="Заблокировать: причина станет стикером «Чужая» на задаче"
              onClick={() => {
                setReason("");
                setPanel("block");
              }}
            >
              <Lock size={15} strokeWidth={2} />
              <span>Заблокировать…</span>
            </button>
          )}
          {blocked && (
            <button type="button" role="menuitem" className="nm-status" onClick={onUnblock}>
              <LockOpen size={15} strokeWidth={2} />
              <span>Разблокировать</span>
            </button>
          )}
        </div>
      )}
      {panel === "block" && (
        <form
          className="node-menu-block"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) onBlock(reason.trim());
          }}
        >
          <Lock size={14} strokeWidth={2} />
          <input
            autoFocus
            value={reason}
            placeholder="Причина блокировки (Enter)"
            aria-label="Причина блокировки"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setPanel("status");
              }
            }}
          />
        </form>
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
            className={`nm-btn${panel === "status" || panel === "block" ? " is-on" : ""}`}
            title="Статус: «Чужая», «Заблокировать…»"
            aria-label="Статус"
            aria-expanded={panel === "status" || panel === "block"}
            onClick={() => setPanel((p) => (p === "status" || p === "block" ? null : "status"))}
          >
            <CircleDashed size={16} strokeWidth={2} />
          </button>
        )}
        {model.kind === "task" && !sticker && (
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
