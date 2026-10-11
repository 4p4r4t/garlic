// Состояние путей, на которые ссылаются ноды графа (ТЗ §4.10, M5.2): существует
// ли путь (битая ссылка — «не найдено»), папка ли это, превью заметки для
// карточки ноды-заметки. Кэш по пути; поля-ссылки запрашивают свои пути сами
// (`useKbStat`), события watcher'а перечитывают всё известное.
//
// Здесь же — реакция графа на `vault:changed`: переименования снаружи (пути в
// БД Rust уже переписал) применяются к кэшу холстов, просвечивание перечитывается.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { api, APP_STATE, VAULT_EVENT, type KbStat, type VaultEvent } from "../api";
import { useGraph } from "./graph";
import { useMode } from "./mode";

const REFRESH_MS = 150;

interface KbLinksState {
  /** Известные состояния путей. Нет ключа — ещё не запрошен. */
  stats: Record<string, KbStat>;
  /** Папка для новых заметок/папок из графа (`kb.default_folder`, "" — корень). */
  defaultFolder: string;

  init: () => Promise<void>;
  /** Запросить состояние путей, которых ещё нет в кэше (пакетом). */
  request: (paths: string[]) => void;
  /** Перечитать все известные пути (с дебаунсом). */
  refresh: () => void;
  setDefaultFolder: (dir: string) => Promise<void>;
}

const pending = new Set<string>();
let requestTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let initPromise: Promise<void> | null = null;

export const useKbLinks = create<KbLinksState>()((set, get) => {
  const fetch = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const list = await api.kbStat(paths);
      set((s) => {
        const stats = { ...s.stats };
        for (const st of list) stats[st.path] = st;
        return { stats };
      });
    } catch (e) {
      console.error("[garlic] kb_stat", e);
    }
  };

  return {
    stats: {},
    defaultFolder: "",

    init: () => {
      initPromise ??= (async () => {
        try {
          set({ defaultFolder: (await api.getAppState(APP_STATE.kbDefaultFolder)) ?? "" });
        } catch {
          // не критично: корень vault
        }
        await listen<VaultEvent[]>(VAULT_EVENT, (e) => onVaultEvents(e.payload));
        // Сменили папку vault в настройках — все ссылки перепроверить.
        useMode.subscribe((s, prev) => {
          if (s.vaultTick !== prev.vaultTick) get().refresh();
        });
      })();
      return initPromise;
    },

    request: (paths) => {
      const known = get().stats;
      for (const p of paths) if (!(p in known)) pending.add(p);
      if (!pending.size) return;
      clearTimeout(requestTimer);
      requestTimer = setTimeout(() => {
        const batch = [...pending];
        pending.clear();
        void fetch(batch);
      }, 0);
    },

    refresh: () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void fetch(Object.keys(get().stats)), REFRESH_MS);
    },

    setDefaultFolder: async (dir) => {
      set({ defaultFolder: dir });
      try {
        await api.setAppState(APP_STATE.kbDefaultFolder, dir);
      } catch (e) {
        useGraph.getState().showError(e);
      }
    },
  };
});

/** Пачка событий watcher'а: переименования — в кэш графа, состояния путей — заново. */
function onVaultEvents(events: VaultEvent[]) {
  const graph = useGraph.getState();
  let touched = false;
  for (const e of events) {
    if (e.kind === "rename" && e.from) {
      graph.rewriteKbPaths(e.from, e.path);
      touched = true;
    } else if (e.kind === "remove" || e.kind === "create") {
      touched = true;
    }
  }
  // Просвечивающие ноды — отдельный снимок из БД (пути уже переписаны Rust'ом).
  if (touched) void graph.refreshSubtree();
  useKbLinks.getState().refresh();
}

/** Состояние пути ссылки; `undefined` — ещё неизвестно (запрос уже отправлен). */
export function useKbStat(path: string | null | undefined): KbStat | undefined {
  const stat = useKbLinks((s) => (path ? s.stats[path] : undefined));
  useEffect(() => {
    if (path && !stat) useKbLinks.getState().request([path]);
  }, [path, stat]);
  return stat;
}
