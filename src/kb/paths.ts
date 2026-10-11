// Пути vault и вики-ссылки. Разрешение ссылок — зеркало src-tauri/src/vault/links.rs.

import type { VaultEntry } from "../api";

export const isMd = (p: string) => p.toLowerCase().endsWith(".md");

/** Последний компонент пути. */
export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Имя заметки без `.md`. */
export const noteName = (p: string) => {
  const b = baseName(p);
  return isMd(b) ? b.slice(0, -3) : b;
};

/** Папка пути (`""` — корень). */
export const parentDir = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** `p` — это `prefix` или лежит внутри папки `prefix`. */
export const isUnder = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");

/** Перенос пути при переименовании `from` → `to` (сам путь или вложенный). */
export function rebase(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(from + "/")) return to + p.slice(from.length);
  return null;
}

/** Все папки-предки пути (без корня): "a/b/c.md" → ["a", "a/b"]. */
export function ancestors(p: string): string[] {
  const parts = p.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Плоские списки заметок и папок дерева. */
export function flatten(tree: VaultEntry[]): { notes: string[]; folders: string[] } {
  const notes: string[] = [];
  const folders: string[] = [];
  const walk = (list: VaultEntry[]) => {
    for (const e of list) {
      if (e.kind === "note") notes.push(e.path);
      else {
        folders.push(e.path);
        walk(e.children ?? []);
      }
    }
  };
  walk(tree);
  return { notes, folders };
}

/** Разобранная вики-ссылка `[[цель#заголовок|псевдоним]]`. */
export interface WikiTarget {
  target: string;
  heading: string | null;
  alias: string | null;
}

export function parseWiki(inner: string): WikiTarget {
  const bar = inner.indexOf("|");
  const left = bar < 0 ? inner : inner.slice(0, bar);
  const alias = bar < 0 ? null : inner.slice(bar + 1).trim() || null;
  const hash = left.indexOf("#");
  const target = (hash < 0 ? left : left.slice(0, hash)).trim();
  const heading = hash < 0 ? null : left.slice(hash + 1).trim() || null;
  return { target, heading, alias };
}

const key = (p: string) => (isMd(p) ? p.slice(0, -3) : p).toLowerCase();

/**
 * Цель ссылки → путь заметки (как в Obsidian): 1) относительно папки источника;
 * 2) от корня vault; 3) по имени/хвосту пути — приоритет у папки источника,
 * затем короче путь, затем по алфавиту.
 */
export function resolveLink(notes: string[], target: string, source: string): string | null {
  const t = key(target.trim().replace(/^\/+/, ""));
  if (!t) return null;
  const srcDir = parentDir(source).toLowerCase();
  if (srcDir) {
    const rel = `${srcDir}/${t}`;
    const hit = notes.find((n) => key(n) === rel);
    if (hit) return hit;
  }
  const exact = notes.find((n) => key(n) === t);
  if (exact) return exact;
  const suffix = "/" + t;
  let best: string | null = null;
  for (const n of notes) {
    if (!key(n).endsWith(suffix)) continue;
    if (best === null || better(n, best, srcDir)) best = n;
  }
  return best;
}

function better(a: string, b: string, srcDir: string): boolean {
  const sa = parentDir(a).toLowerCase() === srcDir;
  const sb = parentDir(b).toLowerCase() === srcDir;
  if (sa !== sb) return sa;
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

/**
 * Текст ссылки на заметку `path` для вставки из `source`: имя, если оно
 * однозначно разрешается в эту заметку, иначе путь без `.md` (как Obsidian
 * «кратчайший путь»).
 */
export function linkText(notes: string[], path: string, source: string): string {
  const name = noteName(path);
  if (resolveLink(notes, name, source) === path) return name;
  return isMd(path) ? path.slice(0, -3) : path;
}

/** Символы, которые очищает Rust (`names::sanitize`) — для подсказки в поле имени. */
export const FORBIDDEN_NAME_RE = /[<>:"/\\|?*#^[\]]/;
