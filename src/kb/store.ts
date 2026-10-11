// Стор режима «База» (ТЗ §4.10): дерево vault, вкладки, панели, открытые
// заметки (NoteDoc — вне zustand, по id вкладки). Состояние интерфейса
// (вкладки, раскрытые папки, ширины панелей) сохраняется в app_state `kb.ui`.

import { create } from "zustand";

import { api, APP_STATE, type VaultEntry, type VaultEvent } from "../api";
import { useGraph } from "../store/graph";
import { EMPTY_META, NoteDoc, type DocMeta, type Reveal } from "./docs";
import {
  ancestors,
  flatten,
  isMd,
  isUnder,
  joinPath,
  noteName,
  parentDir,
  parseWiki,
  rebase,
  resolveLink,
} from "./paths";

export interface Tab {
  id: string;
  path: string;
  /** Режим чтения (иначе Live Preview). */
  reading: boolean;
}

export type LeftView = "files" | "search";
export type RightView = "backlinks" | "outline" | "nodes";

/** Сохраняемая часть состояния. */
interface PersistedUi {
  tabs: { path: string; reading: boolean }[];
  active: number;
  expanded: string[];
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  leftView: LeftView;
  rightView: RightView;
}

export const LEFT_MIN = 180;
export const LEFT_MAX = 520;
export const RIGHT_MIN = 200;
export const RIGHT_MAX = 560;

interface KbState {
  ready: boolean;
  error: string | null;
  tree: VaultEntry[];
  notes: string[];
  folders: string[];

  tabs: Tab[];
  activeId: string | null;
  meta: Record<string, DocMeta>;

  expanded: string[];
  /** Выделенный элемент проводника. */
  selected: string | null;
  /** Элемент проводника в режиме переименования. */
  renaming: string | null;

  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  leftView: LeftView;
  rightView: RightView;

  switcherOpen: boolean;
  searchQuery: string;
  /** Растёт — поле поиска забирает фокус. */
  searchFocus: number;
  /** id вкладки, у которой фокусируется заголовок (новая заметка). */
  titleFocus: string | null;

  init: () => Promise<void>;
  reloadTree: () => Promise<void>;
  /** Сменилась папка vault (настройки): всё закрыть и перечитать. */
  resetVault: () => Promise<void>;

  /** Открыть заметку: в активной вкладке (или новой при `newTab`); уже открытая — активируется. */
  openNote: (path: string, opts?: { newTab?: boolean; reveal?: Reveal }) => Promise<void>;
  activate: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  toggleReading: (id?: string) => void;
  /** Переход по ссылке из заметки `source` (несуществующая — создаётся). */
  openLink: (target: string, source: string, newTab: boolean) => Promise<void>;

  toggleFolder: (path: string) => void;
  /** Раскрыть предков пути и выделить его в проводнике. */
  revealInTree: (path: string) => void;
  collapseAll: () => void;
  select: (path: string | null) => void;
  setRenaming: (path: string | null) => void;

  createNote: (dir: string, name?: string) => Promise<string | null>;
  createFolder: (dir: string, name?: string) => Promise<string | null>;
  rename: (path: string, newName: string) => Promise<string | null>;
  move: (path: string, newDir: string) => Promise<string | null>;
  remove: (path: string) => Promise<void>;

  applyVaultEvents: (events: VaultEvent[]) => void;

  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setLeftView: (v: LeftView) => void;
  setRightView: (v: RightView) => void;
  setSwitcherOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  focusSearch: () => void;
  clearTitleFocus: () => void;
}

/** Открытые заметки по id вкладки. */
export const docs = new Map<string, NoteDoc>();

let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let treeTimer: ReturnType<typeof setTimeout> | undefined;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const showError = (e: unknown) => useGraph.getState().showError(e);

export const useKb = create<KbState>()((set, get) => {
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const s = get();
      const ui: PersistedUi = {
        tabs: s.tabs.map((t) => ({ path: t.path, reading: t.reading })),
        active: Math.max(0, s.tabs.findIndex((t) => t.id === s.activeId)),
        expanded: s.expanded,
        leftOpen: s.leftOpen,
        rightOpen: s.rightOpen,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        leftView: s.leftView,
        rightView: s.rightView,
      };
      void api.setAppState(APP_STATE.kbUi, JSON.stringify(ui)).catch(() => undefined);
    }, 400);
  };

  const makeDoc = (id: string, path: string) =>
    new NoteDoc(id, path, {
      meta: (docId, meta) => set((s) => ({ meta: { ...s.meta, [docId]: meta } })),
      notes: () => get().notes,
      openLink: (target, source, newTab) => void get().openLink(target, source, newTab),
      showError,
    });

  const dropMeta = (id: string) =>
    set((s) => {
      const meta = { ...s.meta };
      delete meta[id];
      return { meta };
    });

  /** Закрыть вкладку без сохранения правок (файл исчез). */
  const discardTab = (id: string) => {
    const doc = docs.get(id);
    docs.delete(id);
    if (doc) {
      doc.view?.destroy();
      doc.view = null;
    }
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    const nextActive =
      activeId === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : activeId;
    set({ tabs: next, activeId: nextActive });
    dropMeta(id);
    persist();
  };

  /** Переписать пути вкладок/дерева после rename/move (в приложении или снаружи). */
  const rebaseAll = (from: string, to: string) => {
    const s = get();
    const tabs = s.tabs.map((t) => {
      const p = rebase(t.path, from, to);
      if (p == null) return t;
      const doc = docs.get(t.id);
      if (doc) doc.path = p;
      return { ...t, path: p };
    });
    const expanded = s.expanded.map((e) => rebase(e, from, to) ?? e);
    const selected = s.selected ? (rebase(s.selected, from, to) ?? s.selected) : null;
    set({ tabs, expanded, selected });
    persist();
  };

  return {
    ready: false,
    error: null,
    tree: [],
    notes: [],
    folders: [],
    tabs: [],
    activeId: null,
    meta: {},
    expanded: [],
    selected: null,
    renaming: null,
    leftOpen: true,
    rightOpen: true,
    leftWidth: 260,
    rightWidth: 280,
    leftView: "files",
    rightView: "backlinks",
    switcherOpen: false,
    searchQuery: "",
    searchFocus: 0,
    titleFocus: null,

    init: async () => {
      let ui: Partial<PersistedUi> = {};
      try {
        const raw = await api.getAppState(APP_STATE.kbUi);
        if (raw) ui = JSON.parse(raw) as Partial<PersistedUi>;
      } catch {
        // повреждённое состояние — по умолчанию
      }
      set({
        expanded: Array.isArray(ui.expanded) ? ui.expanded : [],
        leftOpen: ui.leftOpen ?? true,
        rightOpen: ui.rightOpen ?? true,
        leftWidth: clamp(ui.leftWidth ?? 260, LEFT_MIN, LEFT_MAX),
        rightWidth: clamp(ui.rightWidth ?? 280, RIGHT_MIN, RIGHT_MAX),
        leftView: ui.leftView === "search" ? "search" : "files",
        rightView: ui.rightView === "outline" || ui.rightView === "nodes" ? ui.rightView : "backlinks",
      });
      await get().reloadTree();
      const known = new Set(get().notes);
      const tabs: Tab[] = (Array.isArray(ui.tabs) ? ui.tabs : [])
        .filter((t) => t && typeof t.path === "string" && known.has(t.path))
        .map((t) => ({ id: newTabId(), path: t.path, reading: !!t.reading }));
      const active = tabs[Math.min(ui.active ?? 0, tabs.length - 1)]?.id ?? null;
      set({ tabs, activeId: active, ready: true });
      for (const t of tabs) {
        const doc = makeDoc(t.id, t.path);
        docs.set(t.id, doc);
        void doc.load();
      }
    },

    reloadTree: async () => {
      try {
        const tree = await api.vaultTree();
        const { notes, folders } = flatten(tree);
        set({ tree, notes, folders, error: null });
        docs.forEach((d) => d.refreshLinks());
      } catch (e) {
        set({ error: String(e), tree: [], notes: [], folders: [] });
      }
    },

    resetVault: async () => {
      for (const [id, doc] of docs) {
        await doc.flush();
        doc.view?.destroy();
        docs.delete(id);
      }
      set({ tabs: [], activeId: null, meta: {}, expanded: [], selected: null });
      persist();
      await get().reloadTree();
    },

    openNote: async (path, opts = {}) => {
      const s = get();
      const existing = s.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id, selected: path });
        if (opts.reveal) docs.get(existing.id)?.reveal(opts.reveal);
        persist();
        return;
      }
      const id = newTabId();
      const tab: Tab = { id, path, reading: false };
      const active = s.tabs.find((t) => t.id === s.activeId);
      let tabs: Tab[];
      if (!opts.newTab && active) {
        // Как в Obsidian: открытие заменяет заметку активной вкладки.
        const old = docs.get(active.id);
        docs.delete(active.id);
        if (old) void old.destroy();
        dropMeta(active.id);
        tab.reading = active.reading;
        tabs = s.tabs.map((t) => (t.id === active.id ? tab : t));
      } else {
        const idx = s.tabs.findIndex((t) => t.id === s.activeId);
        tabs = [...s.tabs];
        tabs.splice(idx + 1, 0, tab);
      }
      const doc = makeDoc(id, path);
      docs.set(id, doc);
      set({ tabs, activeId: id, selected: path });
      persist();
      await doc.load(opts.reveal ?? null);
    },

    activate: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      set({ activeId: id, selected: tab.path });
      persist();
    },

    closeTab: async (id) => {
      const doc = docs.get(id);
      const { tabs, activeId } = get();
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const next = tabs.filter((t) => t.id !== id);
      const nextActive =
        activeId === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : activeId;
      set({ tabs: next, activeId: nextActive });
      docs.delete(id);
      persist();
      if (doc) await doc.destroy();
      dropMeta(id);
    },

    toggleReading: (id) => {
      const target = id ?? get().activeId;
      if (!target) return;
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === target ? { ...t, reading: !t.reading } : t)) }));
      persist();
    },

    openLink: async (raw, source, newTab) => {
      const { target, heading } = parseWiki(raw);
      const reveal: Reveal = heading ? { heading } : null;
      if (!target) {
        // [[#Заголовок]] — в этой же заметке.
        const tab = get().tabs.find((t) => t.path === source);
        if (tab && reveal) docs.get(tab.id)?.reveal(reveal);
        return;
      }
      const found = resolveLink(get().notes, target, source);
      if (found) {
        await get().openNote(found, { newTab, reveal });
        return;
      }
      // Несуществующая — создаём (в папке из пути ссылки, если она есть, иначе в корне).
      const clean = isMd(target) ? target.slice(0, -3) : target;
      const dir = parentDir(clean);
      const folder = dir && get().folders.includes(dir) ? dir : "";
      try {
        const path = await api.vaultCreateNote(folder, noteName(clean));
        await get().reloadTree();
        await get().openNote(path, { newTab });
      } catch (e) {
        showError(e);
      }
    },

    toggleFolder: (path) => {
      set((s) => ({
        expanded: s.expanded.includes(path)
          ? s.expanded.filter((e) => e !== path)
          : [...s.expanded, path],
      }));
      persist();
    },

    revealInTree: (path) => {
      // Папка (путь без .md) раскрывается и сама — «показать папку» из графа (M5.2).
      const chain = isMd(path) || !path ? ancestors(path) : [...ancestors(path), path];
      const add = chain.filter((a) => !get().expanded.includes(a));
      set((s) => ({
        expanded: [...s.expanded, ...add],
        selected: path,
        leftOpen: true,
        leftView: "files",
      }));
      persist();
    },

    collapseAll: () => {
      set({ expanded: [] });
      persist();
    },

    select: (path) => set({ selected: path }),
    setRenaming: (path) => set({ renaming: path }),

    createNote: async (dir, name = "Без названия") => {
      try {
        const path = await api.vaultCreateNote(dir, name);
        if (dir && !get().expanded.includes(dir)) get().revealInTree(path);
        await get().reloadTree();
        await get().openNote(path);
        set({ titleFocus: get().activeId });
        return path;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    createFolder: async (dir, name = "Новая папка") => {
      try {
        const path = await api.vaultCreateFolder(dir, name);
        get().revealInTree(path);
        await get().reloadTree();
        set({ renaming: path, selected: path });
        return path;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    rename: async (path, newName) => {
      const name = newName.trim();
      if (!name) return null;
      // Несохранённое — сначала на диск, потом переименование.
      for (const t of get().tabs) if (isUnder(t.path, path)) await docs.get(t.id)?.flush();
      try {
        const to = await api.vaultRename(path, name);
        if (to !== path) rebaseAll(path, to);
        await get().reloadTree();
        return to;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    move: async (path, newDir) => {
      if (parentDir(path) === newDir || isUnder(newDir, path)) return null;
      for (const t of get().tabs) if (isUnder(t.path, path)) await docs.get(t.id)?.flush();
      try {
        const to = await api.vaultMove(path, newDir);
        rebaseAll(path, to);
        if (newDir && !get().expanded.includes(newDir)) {
          set((s) => ({ expanded: [...s.expanded, ...ancestors(to).filter((a) => !s.expanded.includes(a))] }));
        }
        await get().reloadTree();
        return to;
      } catch (e) {
        showError(e);
        return null;
      }
    },

    remove: async (path) => {
      try {
        await api.vaultDelete(path);
        for (const t of get().tabs.filter((t) => isUnder(t.path, path))) discardTab(t.id);
        set((s) => ({ expanded: s.expanded.filter((e) => !isUnder(e, path)) }));
        await get().reloadTree();
      } catch (e) {
        showError(e);
      }
    },

    applyVaultEvents: (events) => {
      for (const e of events) {
        if (e.kind === "rename" && e.from) {
          rebaseAll(e.from, e.path);
        } else if (e.kind === "remove") {
          for (const t of get().tabs.filter((t) => isUnder(t.path, e.path))) {
            const doc = docs.get(t.id);
            if (doc?.isDirty()) doc.markMissing();
            else discardTab(t.id);
          }
        } else if (e.kind === "modify" || e.kind === "create") {
          for (const t of get().tabs) if (t.path === e.path) void docs.get(t.id)?.external();
        }
      }
      clearTimeout(treeTimer);
      treeTimer = setTimeout(() => void get().reloadTree(), 120);
    },

    setLeftOpen: (open) => {
      set({ leftOpen: open });
      persist();
    },
    setRightOpen: (open) => {
      set({ rightOpen: open });
      persist();
    },
    setLeftWidth: (w) => {
      set({ leftWidth: clamp(w, LEFT_MIN, LEFT_MAX) });
      persist();
    },
    setRightWidth: (w) => {
      set({ rightWidth: clamp(w, RIGHT_MIN, RIGHT_MAX) });
      persist();
    },
    setLeftView: (v) => {
      set({ leftView: v, leftOpen: true });
      persist();
    },
    setRightView: (v) => {
      set({ rightView: v, rightOpen: true });
      persist();
    },
    setSwitcherOpen: (open) => set({ switcherOpen: open }),
    setSearchQuery: (q) => set({ searchQuery: q }),
    focusSearch: () =>
      set((s) => ({ leftOpen: true, leftView: "search", searchFocus: s.searchFocus + 1 })),
    clearTitleFocus: () => set({ titleFocus: null }),
  };
});

/** Мета открытой заметки вкладки. */
export const useDocMeta = (id: string | null): DocMeta =>
  useKb((s) => (id ? (s.meta[id] ?? EMPTY_META) : EMPTY_META));

/** Сохранить всё несохранённое (уход из приложения/режима). */
export async function flushAllDocs(): Promise<void> {
  await Promise.all([...docs.values()].map((d) => d.flush()));
}

export { joinPath };
