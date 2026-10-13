// Горячие клавиши графа (M6b): T / N — новая задача / заметка под курсором,
// Tab — войти в слой выделенной задачи, Shift+Tab — на уровень выше, F2 —
// переименовать, Space — следующий статус выделенных, ? — справка.
// Работают только в режиме «Граф» и не срабатывают в полях ввода, CodeMirror,
// меню и окнах поверх графа. Клавиши привязаны к физическим кнопкам (e.code),
// чтобы работать на любой раскладке.

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { create } from "zustand";

import type { NodeKind, TaskStatus } from "../api";
import { NEXT_STATUS, useGraph } from "../store/graph";
import { isGraphMode } from "../store/mode";
import type { FlowEdge, FlowNode } from "./flow";

/** Последняя позиция курсора в окне (для T / N «под курсором»). */
let pointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true, capture: true },
  );
}

/** Окна и меню поверх графа: пока они открыты, клавиши графа молчат. */
const OVERLAYS =
  ".ctx-menu, .node-menu, .spaces-panel, .settings-panel, .ov-panel, .gs-backdrop, .kbp-backdrop, .kb-modal-backdrop, .gm-backdrop, .is-connecting";

/** Клавиша адресована графу: фокус не в поле ввода / редакторе / меню и не над окном. */
export function keyForGraph(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || !isGraphMode()) return false;
  const t = e.target;
  if (t instanceof Element) {
    if (t.closest("input, textarea, select, [contenteditable], .cm-editor")) return false;
    // Кнопки и поля интерфейса вне холста (топбар, панели) — не наши.
    if (t !== document.body && !t.closest(".graph-view")) return false;
  }
  return !document.querySelector(OVERLAYS);
}

interface HelpState {
  open: boolean;
  setOpen: (open: boolean) => void;
}
export const useHotkeyHelp = create<HelpState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Выделенные ноды холста `canvasId`. */
function selectedOf(canvasId: string): FlowNode[] {
  return useGraph.getState().canvases[canvasId]?.nodes.filter((n) => n.selected) ?? [];
}

/**
 * Клавиши верхнего холста. Монтируется внутри `ReactFlowProvider` активного
 * уровня (для `screenToFlowPosition`); `root` — элемент холста.
 */
export function CanvasHotkeys({
  canvasId,
  root,
}: {
  canvasId: string;
  root: React.RefObject<HTMLElement | null>;
}) {
  const { screenToFlowPosition } = useReactFlow<FlowNode, FlowEdge>();

  useEffect(() => {
    /** Точка создания: под курсором, а если курсор вне холста — центр холста. */
    const spot = () => {
      const r = root.current?.getBoundingClientRect();
      const p =
        pointer && r && pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom
          ? pointer
          : r
            ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
            : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      return screenToFlowPosition(p);
    };
    const create = (kind: NodeKind) => void useGraph.getState().createNode(canvasId, kind, spot());

    /** Space: единый следующий статус для всех выделенных задач (по первой). */
    const cycle = (): boolean => {
      const tasks = selectedOf(canvasId).filter((n) => n.data.model.kind === "task");
      if (!tasks.length) return false;
      const g = useGraph.getState();
      if (tasks.length === 1) {
        g.cycleStatus(canvasId, tasks[0].id);
      } else {
        const first: TaskStatus = tasks[0].data.model.status ?? "todo";
        void g.setStatusMany(
          canvasId,
          tasks.map((n) => n.id),
          NEXT_STATUS[first],
        );
      }
      return true;
    };

    let swallowSpaceUp = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!keyForGraph(e)) return;
      const g = useGraph.getState();
      const handled = (() => {
        switch (e.code) {
          case "KeyT":
          case "KeyN":
            if (e.shiftKey || e.repeat) return false;
            create(e.code === "KeyT" ? "task" : "note");
            return true;
          case "Tab": {
            if (e.shiftKey) {
              if (g.layers.length > 1) void g.exitTo(g.layers.length - 2);
              return true;
            }
            const sel = selectedOf(canvasId);
            if (sel.length === 1 && sel[0].data.model.kind === "task") void g.enterLayer(sel[0].id);
            return true;
          }
          case "F2": {
            const sel = selectedOf(canvasId);
            if (sel.length === 1) g.startEditing(sel[0].id);
            return sel.length === 1;
          }
          case "Space":
            if (e.shiftKey || e.repeat) return false;
            if (!cycle()) return false;
            swallowSpaceUp = true;
            return true;
          default:
            return false;
        }
      })();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Пробел на сфокусированной кнопке «кликает» её на keyup — гасим.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && swallowSpaceUp) {
        swallowSpaceUp = false;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [canvasId, root, screenToFlowPosition]);

  return null;
}

/** `?` — справка по клавишам; монтируется один раз в App. */
export function HotkeyHelp() {
  const open = useHotkeyHelp((s) => s.open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (useHotkeyHelp.getState().open) {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          e.stopPropagation();
          useHotkeyHelp.getState().setOpen(false);
        }
        return;
      }
      if (e.key === "?" && keyForGraph(e)) {
        e.preventDefault();
        useHotkeyHelp.getState().setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Смена режима закрывает справку.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      if (!isGraphMode()) useHotkeyHelp.getState().setOpen(false);
    }, 300);
    return () => clearInterval(t);
  }, [open]);

  if (!open) return null;
  const close = () => useHotkeyHelp.getState().setOpen(false);
  return (
    <div className="hk-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="hk-help" role="dialog" aria-label="Горячие клавиши">
        <div className="hk-title">Горячие клавиши</div>
        {HELP.map(([keys, text]) => (
          <div key={text} className="hk-row">
            <span className="hk-keys">
              {keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
            <span>{text}</span>
          </div>
        ))}
        <div className="hk-foot">
          <kbd>?</kbd> или <kbd>Esc</kbd> — закрыть
        </div>
      </div>
    </div>
  );
}

const HELP: [string[], string][] = [
  [["T"], "Новая задача под курсором"],
  [["N"], "Новая заметка под курсором"],
  [["Tab"], "Войти в слой выделенной задачи"],
  [["Shift", "Tab"], "На уровень выше"],
  [["F2"], "Переименовать выделенную ноду"],
  [["Space"], "Следующий статус выделенных задач"],
  [["Delete"], "Удалить выделенное"],
  [["Esc"], "Выйти из слоя / закрыть меню"],
  [["Ctrl", "K"], "Поиск по графу"],
  [["Ctrl", "1"], "Режим «Граф»"],
  [["Ctrl", "2"], "Режим «База»"],
];
