import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";

import { useGraph } from "../store/graph";
import { InlineInput } from "./InlineInput";

interface Props {
  /** Кнопка «Пространства»: клик по ней не считается «кликом мимо». */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}

type Mode = { kind: "idle" } | { kind: "rename" | "confirm"; id: string } | { kind: "create" };

/**
 * Выпадающая панель пространств (ТЗ §4.6): список с переключением,
 * создание, переименование и удаление с подтверждением.
 * Закрывается по Esc / клику мимо / после переключения или создания.
 */
export function SpacesPanel({ anchor, onClose }: Props) {
  const spaces = useGraph((s) => s.spaces);
  const activeSpaceId = useGraph((s) => s.activeSpaceId);
  const switchSpace = useGraph((s) => s.switchSpace);
  const createSpace = useGraph((s) => s.createSpace);
  const renameSpace = useGraph((s) => s.renameSpace);
  const deleteSpace = useGraph((s) => s.deleteSpace);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const ref = useRef<HTMLDivElement>(null);
  const idle = () => setMode({ kind: "idle" });
  // Последнее пространство удалить нельзя (то же правило в Rust).
  const canDelete = spaces.length > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  const pick = (id: string) => {
    onClose();
    if (id !== activeSpaceId) void switchSpace(id);
  };

  return (
    <div ref={ref} className="spaces-panel" role="menu" aria-label="Пространства">
      <ul className="sp-list">
        {spaces.map((sp) => {
          const current = sp.id === activeSpaceId;
          if (mode.kind === "rename" && mode.id === sp.id) {
            return (
              <li key={sp.id} className="sp-item is-editing">
                <InlineInput
                  initial={sp.name}
                  onCommit={(name) => {
                    idle();
                    if (name !== sp.name) void renameSpace(sp.id, name);
                  }}
                  onCancel={idle}
                />
              </li>
            );
          }
          if (mode.kind === "confirm" && mode.id === sp.id) {
            return (
              <li key={sp.id} className="sp-item is-confirm">
                <span className="sp-confirm-text">Удалить «{sp.name}» со всем содержимым?</span>
                <div className="sp-confirm-actions">
                  <button
                    type="button"
                    className="sp-btn is-danger"
                    autoFocus
                    onClick={() => {
                      idle();
                      void deleteSpace(sp.id);
                    }}
                  >
                    Удалить
                  </button>
                  <button type="button" className="sp-btn" onClick={idle}>
                    Отмена
                  </button>
                </div>
              </li>
            );
          }
          return (
            <li key={sp.id} className={current ? "sp-item is-current" : "sp-item"}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={current}
                className="sp-name"
                title={sp.name}
                onClick={() => pick(sp.id)}
              >
                <span className="sp-mark">{current && <Check size={14} />}</span>
                <span className="sp-label">{sp.name}</span>
              </button>
              <button
                type="button"
                className="sp-act"
                title="Переименовать"
                aria-label={`Переименовать «${sp.name}»`}
                onClick={() => setMode({ kind: "rename", id: sp.id })}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="sp-act is-danger"
                title={canDelete ? "Удалить" : "Последнее пространство удалить нельзя"}
                aria-label={`Удалить «${sp.name}»`}
                disabled={!canDelete}
                onClick={() => setMode({ kind: "confirm", id: sp.id })}
              >
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sp-footer">
        {mode.kind === "create" ? (
          <InlineInput
            initial=""
            placeholder="Название пространства"
            onCommit={(name) => {
              idle();
              void createSpace(name).then((ok) => ok && onClose());
            }}
            onCancel={idle}
          />
        ) : (
          <button type="button" className="sp-new" onClick={() => setMode({ kind: "create" })}>
            <Plus size={14} />
            <span>Новое пространство</span>
          </button>
        )}
      </div>
    </div>
  );
}
