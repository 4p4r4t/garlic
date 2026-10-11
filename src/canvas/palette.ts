// Палитра нод (ТЗ §8). Ключи совпадают с repo::nodes::PALETTE в Rust.
// Меню выбора цвета — M2; отрисовка заливки поддержана уже сейчас.

import type { CSSProperties } from "react";

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
