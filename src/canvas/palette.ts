// Палитра нод (ТЗ §8). Ключи совпадают с repo::nodes::PALETTE в Rust.
// Выбор цвета — меню ноды (NodeMenu, ТЗ §4.4).

import type { CSSProperties } from "react";

import type { NodeModel, TaskStatus } from "../api";

export const PALETTE: Record<string, string> = {
  red: "#b5545c",
  orange: "#c07a45",
  yellow: "#c9a945",
  green: "#5f9a62",
  teal: "#4b9690",
  blue: "#4f7fbf",
  violet: "#8566b8",
  gray: "#6e737d",
};

/** Контрастный цвет текста для заливки (по относительной яркости). */
export function textColorFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.22 ? "#16171b" : "#f4f4f6";
}

/** Inline-стиль заливки ноды или undefined, если цвет не задан. */
export function fillStyle(color: string | null): CSSProperties | undefined {
  const bg = color ? PALETTE[color] : undefined;
  if (!bg) return undefined;
  const fg = textColorFor(bg);
  return {
    background: bg,
    borderColor: bg,
    color: fg,
    ["--node-fg" as string]: fg,
    ["--node-muted" as string]: fg,
  };
}

/** Цвет заливки по статусу задачи: ключ палитры или null — «нет» (ТЗ §4.3, v1.2). */
export type StatusColors = Record<TaskStatus, string | null>;

export const DEFAULT_STATUS_COLORS: StatusColors = {
  todo: null,
  in_progress: "blue",
  done: "green",
  blocked: "red",
  foreign: "orange",
};

/** Разбор `app_state.status_colors`; неизвестные ключи палитры — «нет», пропуски — по умолчанию. */
export function parseStatusColors(raw: string | null): StatusColors {
  const out = { ...DEFAULT_STATUS_COLORS };
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") {
      for (const k of Object.keys(out) as TaskStatus[]) {
        if (!(k in v)) continue;
        const c = (v as Record<string, unknown>)[k];
        out[k] = typeof c === "string" && c in PALETTE ? c : null;
      }
    }
  } catch {
    // битое значение — цвета по умолчанию
  }
  return out;
}

/**
 * Итоговый цвет заливки ноды (ТЗ §1): цвет статуса, если он задан для статуса
 * задачи; иначе ручной цвет из меню ноды; иначе null — стандартный фон.
 */
export function nodeFillColor(model: NodeModel, statusColors: StatusColors): string | null {
  const byStatus = model.kind === "task" && model.status ? statusColors[model.status] : null;
  return byStatus ?? model.color;
}
