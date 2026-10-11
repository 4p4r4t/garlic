import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SquareCheck, StickyNote } from "lucide-react";

import type { NodeKind } from "../api";

interface Props {
  /** Координаты экрана (clientX/clientY), где открыто меню. */
  x: number;
  y: number;
  onPick: (kind: NodeKind) => void;
  onClose: () => void;
}

const ITEMS: { kind: NodeKind; label: string; icon: typeof StickyNote }[] = [
  { kind: "task", label: "Задача", icon: SquareCheck },
  { kind: "note", label: "Заметка", icon: StickyNote },
];

/** Контекстное меню пустого холста (ТЗ §4.2). Закрывается по Esc / клику мимо. */
export function CanvasMenu({ x, y, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Не даём меню вылезти за край окна.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - width - 4),
      top: Math.min(y, window.innerHeight - height - 4),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onBlur, { passive: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onBlur);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ITEMS.map(({ kind, label, icon: Icon }) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => onPick(kind)}
        >
          <Icon size={15} strokeWidth={2} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
