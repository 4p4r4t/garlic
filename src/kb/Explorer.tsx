// Проводник vault (левая панель): дерево, сворачивание, новая заметка/папка,
// переименование на месте (F2 / меню), удаление (Delete / меню, в корзину),
// перетаскивание в папку, контекстное меню, сортировка «папки, затем по имени».

import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  PanelRight,
  Pencil,
  Trash2,
} from "lucide-react";

import { api, type VaultEntry } from "../api";
import { useGraph } from "../store/graph";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { baseName, isUnder, noteName, parentDir } from "./paths";
import { useKb } from "./store";

interface MenuState {
  x: number;
  y: number;
  entry: VaultEntry | null;
}

const DRAG_TYPE = "application/x-garlic-vault-path";

/** Папка, в которой создавать новое из шапки: выделенная папка или папка выделенной заметки. */
function targetDir(selected: string | null, folders: string[]): string {
  if (!selected) return "";
  if (folders.includes(selected)) return selected;
  return parentDir(selected);
}

export async function revealInOs(path: string) {
  try {
    const abs = await api.vaultAbsPath(path);
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(abs);
  } catch (e) {
    useGraph.getState().showError(e);
  }
}

export function confirmDelete(entry: { path: string; isFolder: boolean }): boolean {
  const name = entry.isFolder ? baseName(entry.path) : noteName(entry.path);
  return window.confirm(
    entry.isFolder
      ? `Удалить папку «${name}» со всем содержимым? Она попадёт в корзину.`
      : `Удалить заметку «${name}»? Она попадёт в корзину.`,
  );
}

export function Explorer() {
  const tree = useKb((s) => s.tree);
  const folders = useKb((s) => s.folders);
  const selected = useKb((s) => s.selected);
  const createNote = useKb((s) => s.createNote);
  const createFolder = useKb((s) => s.createFolder);
  const collapseAll = useKb((s) => s.collapseAll);
  const move = useKb((s) => s.move);
  const error = useKb((s) => s.error);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);

  const onRootDrop = (e: DragEvent) => {
    const from = e.dataTransfer.getData(DRAG_TYPE);
    setRootDrop(false);
    if (!from) return;
    e.preventDefault();
    void move(from, "");
  };

  return (
    <div className="kb-explorer">
      <div className="kb-nav-header">
        <button
          type="button"
          className="kb-nav-btn"
          title="Новая заметка"
          onClick={() => void createNote(targetDir(selected, folders))}
        >
          <FilePlus2 size={16} />
        </button>
        <button
          type="button"
          className="kb-nav-btn"
          title="Новая папка"
          onClick={() => void createFolder(targetDir(selected, folders))}
        >
          <FolderPlus size={16} />
        </button>
        <button type="button" className="kb-nav-btn" title="Свернуть всё" onClick={collapseAll}>
          <ChevronsDownUp size={16} />
        </button>
      </div>
      <div
        className={rootDrop ? "kb-tree is-drop" : "kb-tree"}
        role="tree"
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          if ((e.target as HTMLElement).closest(".kb-tree-item.is-folder")) return;
          e.preventDefault();
          setRootDrop(true);
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setRootDrop(false);
        }}
        onDrop={onRootDrop}
        onClick={(e) => {
          if (e.target === e.currentTarget) useKb.getState().select(null);
        }}
      >
        {error && <div className="kb-empty is-error">{error}</div>}
        {!error && tree.length === 0 && <div className="kb-empty">Пусто. Создайте первую заметку.</div>}
        <TreeLevel entries={tree} depth={0} onMenu={setMenu} />
      </div>
      {menu && <TreeMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}

function TreeLevel({
  entries,
  depth,
  onMenu,
}: {
  entries: VaultEntry[];
  depth: number;
  onMenu: (m: MenuState) => void;
}) {
  return (
    <>
      {entries.map((e) => (
        <TreeItem key={e.path} entry={e} depth={depth} onMenu={onMenu} />
      ))}
    </>
  );
}

function TreeItem({
  entry,
  depth,
  onMenu,
}: {
  entry: VaultEntry;
  depth: number;
  onMenu: (m: MenuState) => void;
}) {
  const isFolder = entry.kind === "folder";
  const expanded = useKb((s) => isFolder && s.expanded.includes(entry.path));
  const selected = useKb((s) => s.selected === entry.path);
  const active = useKb((s) => !isFolder && s.tabs.find((t) => t.id === s.activeId)?.path === entry.path);
  const renaming = useKb((s) => s.renaming === entry.path);
  const [drop, setDrop] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const kb = useKb.getState;
  const label = isFolder ? entry.name : noteName(entry.path);

  const onClick = (e: React.MouseEvent) => {
    kb().select(entry.path);
    if (isFolder) kb().toggleFolder(entry.path);
    else void kb().openNote(entry.path, { newTab: e.ctrlKey || e.metaKey });
    rowRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (renaming) return;
    if (e.key === "F2") {
      e.preventDefault();
      kb().setRenaming(entry.path);
    } else if (e.key === "Delete") {
      e.preventDefault();
      if (confirmDelete({ path: entry.path, isFolder })) void kb().remove(entry.path);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isFolder) kb().toggleFolder(entry.path);
      else void kb().openNote(entry.path);
    }
  };

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, entry.path);
    e.dataTransfer.setData("text/plain", `[[${noteName(entry.path)}]]`);
    e.dataTransfer.effectAllowed = "move";
  };

  const dropProps = isFolder
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDrop(true);
        },
        onDragLeave: () => setDrop(false),
        onDrop: (e: DragEvent) => {
          const from = e.dataTransfer.getData(DRAG_TYPE);
          setDrop(false);
          if (!from) return;
          e.preventDefault();
          e.stopPropagation();
          if (from === entry.path || isUnder(entry.path, from)) return;
          void kb().move(from, entry.path);
          if (!kb().expanded.includes(entry.path)) kb().toggleFolder(entry.path);
        },
      }
    : {};

  return (
    <div className="kb-tree-node" role="treeitem" aria-expanded={isFolder ? expanded : undefined}>
      <div
        ref={rowRef}
        tabIndex={-1}
        className={[
          "kb-tree-item",
          isFolder ? "is-folder" : "is-note",
          selected ? "is-selected" : "",
          active ? "is-active" : "",
          drop ? "is-drop" : "",
        ].join(" ")}
        style={{ paddingLeft: 8 + depth * 17 }}
        draggable={!renaming}
        onDragStart={onDragStart}
        onClick={renaming ? undefined : onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          kb().select(entry.path);
          onMenu({ x: e.clientX, y: e.clientY, entry });
        }}
        title={entry.path}
        {...dropProps}
      >
        {isFolder ? (
          <ChevronRight size={14} className={expanded ? "kb-chevron is-open" : "kb-chevron"} />
        ) : (
          <span className="kb-chevron-space" />
        )}
        {renaming ? (
          <RenameInput entry={entry} initial={label} />
        ) : (
          <span className="kb-tree-label">{label}</span>
        )}
      </div>
      {isFolder && expanded && entry.children && entry.children.length > 0 && (
        <div className="kb-tree-children" style={{ ["--guide-x" as string]: `${15 + depth * 17}px` }}>
          <TreeLevel entries={entry.children} depth={depth + 1} onMenu={onMenu} />
        </div>
      )}
    </div>
  );
}

function RenameInput({ entry, initial }: { entry: VaultEntry; initial: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const kb = useKb.getState();
    kb.setRenaming(null);
    const value = ref.current?.value.trim() ?? "";
    if (commit && value && value !== initial) {
      void kb.rename(entry.path, value).then((to) => to && kb.select(to));
    }
  };
  return (
    <input
      ref={ref}
      className="kb-rename-input"
      defaultValue={initial}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

function TreeMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const kb = useKb.getState;
  const e = menu.entry;
  let items: MenuEntry[];
  if (!e) {
    items = [
      { label: "Новая заметка", icon: <FilePlus2 size={14} />, onClick: () => void kb().createNote("") },
      { label: "Новая папка", icon: <FolderPlus size={14} />, onClick: () => void kb().createFolder("") },
    ];
  } else if (e.kind === "folder") {
    items = [
      { label: "Новая заметка", icon: <FilePlus2 size={14} />, onClick: () => void kb().createNote(e.path) },
      { label: "Новая папка", icon: <FolderPlus size={14} />, onClick: () => void kb().createFolder(e.path) },
      "sep",
      { label: "Переименовать", icon: <Pencil size={14} />, onClick: () => kb().setRenaming(e.path) },
      { label: "Показать в проводнике", icon: <FolderOpen size={14} />, onClick: () => void revealInOs(e.path) },
      "sep",
      {
        label: "Удалить",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => confirmDelete({ path: e.path, isFolder: true }) && void kb().remove(e.path),
      },
    ];
  } else {
    items = [
      {
        label: "Открыть в новой вкладке",
        icon: <PanelRight size={14} />,
        onClick: () => void kb().openNote(e.path, { newTab: true }),
      },
      { label: "Переименовать", icon: <Pencil size={14} />, onClick: () => kb().setRenaming(e.path) },
      { label: "Показать в проводнике", icon: <FolderOpen size={14} />, onClick: () => void revealInOs(e.path) },
      "sep",
      {
        label: "Удалить",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => confirmDelete({ path: e.path, isFolder: false }) && void kb().remove(e.path),
      },
    ];
  }
  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={onClose} />;
}

