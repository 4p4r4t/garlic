// «Результаты» задач для фильтра проводника «Показывать только результаты»
// (ТЗ §4.11): какие пути vault привязаны как «Результат» к задачам, какие
// записи дерева тогда видны, что ищут Ctrl+O и поиск.
//
// Список приходит из Rust (`kb_result_links`) и перечитывается KbMode при
// изменениях: дерево vault (watcher, переименования в «Базе»), кэш графа
// (ссылки, статусы, удаление задач), вход в режим «База».

import { create } from "zustand";

import { api, type ResultLink, type TaskStatus, type VaultEntry } from "../api";
import { ancestors } from "./paths";

/**
 * Результаты задач каких статусов показывает фильтр; `null` — любого статуса.
 * Например, `["done"]` — только результаты завершённых задач.
 */
export const RESULT_FILTER_STATUSES = null as readonly TaskStatus[] | null;

const REFRESH_MS = 250;

/** Результаты по пути: путь → задачи, у которых он «Результат». */
export type ResultsByPath = ReadonlyMap<string, readonly ResultLink[]>;

interface ResultsState {
  byPath: ResultsByPath;
  loaded: boolean;
  /** Перечитать сейчас. */
  load: () => Promise<void>;
  /** Перечитать с дебаунсом (пачки изменений графа/дерева). */
  refresh: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

export const useResults = create<ResultsState>()((set, get) => ({
  byPath: new Map(),
  loaded: false,

  load: async () => {
    clearTimeout(timer);
    const my = ++seq;
    try {
      const list = await api.kbResultLinks();
      if (my !== seq) return;
      const byPath = new Map<string, ResultLink[]>();
      for (const r of list) {
        if (RESULT_FILTER_STATUSES && !RESULT_FILTER_STATUSES.includes(r.status)) continue;
        const arr = byPath.get(r.path);
        if (arr) arr.push(r);
        else byPath.set(r.path, [r]);
      }
      set({ byPath, loaded: true });
    } catch (e) {
      console.error("[garlic] kb_result_links", e);
    }
  },

  refresh: () => {
    clearTimeout(timer);
    timer = setTimeout(() => void get().load(), REFRESH_MS);
  },
}));

/** Путь — результат или лежит внутри папки-результата. */
export function inResults(path: string, byPath: ResultsByPath): boolean {
  if (byPath.has(path)) return true;
  return ancestors(path).some((a) => byPath.has(a));
}

/**
 * Дерево под фильтром: результаты (папка — со всем содержимым) и папки-предки,
 * нужные, чтобы до них дойти. Пропавшие пути (битые ссылки) не показываются.
 */
export function filterTree(tree: VaultEntry[], byPath: ResultsByPath): VaultEntry[] {
  const walk = (entries: VaultEntry[]): VaultEntry[] => {
    const out: VaultEntry[] = [];
    for (const e of entries) {
      if (byPath.has(e.path)) {
        out.push(e);
      } else if (e.kind === "folder" && e.children?.length) {
        const kids = walk(e.children);
        if (kids.length) out.push({ ...e, children: kids });
      }
    }
    return out;
  };
  return walk(tree);
}

/** Папки, которые надо раскрыть, чтобы были видны все результаты. */
export function resultAncestors(byPath: ResultsByPath): string[] {
  const out = new Set<string>();
  for (const p of byPath.keys()) for (const a of ancestors(p)) out.add(a);
  return [...out];
}

/** Путь задачи для тултипа: `Пространство › Задача A › Подзадача B`. */
export const taskPathLabel = (r: ResultLink) =>
  [r.spaceName, ...r.parents, r.title || "Без названия"].join(" › ");
