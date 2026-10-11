// Поле-ссылка ноды на базу знаний (ТЗ §4.10): описание «слота» и действия.
//
// Всё здесь не знает, где хранится ссылка: действия получают текущий путь и
// функцию записи `LinkSetter`. Сейчас у каждой ноды один слот (`nodes.kb_path`):
// у задачи — `TASK_LINK`, у заметки — `NOTE_FILE` (её собственный .md). В M5.3
// у задачи появятся «Комментарий» и «Результат» — ещё два слота со своими
// подписью, иконкой, именем по умолчанию и папкой.

import { FileText, type LucideIcon } from "lucide-react";

import { api } from "../api";
import { useGraph } from "../store/graph";
import { useMode } from "../store/mode";

/** Записать новую ссылку (null — отвязать). */
export type LinkSetter = (path: string | null) => Promise<void>;

export interface LinkSlot {
  /** Ключ слота (для React key, будущих ролей). */
  key: string;
  /** Маленькая подпись над полем; нет — без подписи. */
  label?: string;
  /** Иконка подписи. */
  icon?: LucideIcon;
  /** Плейсхолдер пустого поля. */
  placeholder: string;
  /** Имя новой заметки/папки по заголовку ноды. */
  defaultName: (title: string) => string;
  /** Папка для создания; null — `kb.default_folder` (настройки). */
  defaultDir: () => string | null;
  /** Можно ли ссылаться на папку (у ноды-заметки — только её .md). */
  allowFolders: boolean;
  /** Показывать путь целиком, а не только имя (у заметки имя = заголовок). */
  showPath: boolean;
}

/** Пустой заголовок → «Без названия» (как names::UNTITLED в Rust). */
export const UNTITLED = "Без названия";
const byTitle = (title: string) => title.trim() || UNTITLED;

/** Ссылка задачи (M5.2: одна; в M5.3 станет «Комментарием»). */
export const TASK_LINK: LinkSlot = {
  key: "kb",
  placeholder: "+ база знаний",
  defaultName: byTitle,
  defaultDir: () => null,
  allowFolders: true,
  showPath: false,
};

/** Нода-заметка — карточка своего .md. */
export const NOTE_FILE: LinkSlot = {
  key: "note",
  placeholder: "+ база знаний",
  icon: FileText,
  defaultName: byTitle,
  defaultDir: () => null,
  allowFolders: false,
  showPath: true,
};

export const isNotePath = (p: string) => p.toLowerCase().endsWith(".md");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Имя для показа: у заметки — без .md. */
export const linkName = (p: string) => (isNotePath(p) ? baseName(p).slice(0, -3) : baseName(p));
/** Путь для показа: без .md. */
export const linkPathLabel = (p: string) => (isNotePath(p) ? p.slice(0, -3) : p);

const showError = (e: unknown) => useGraph.getState().showError(e);

/** Создать заметку/папку для слота и привязать её. */
export async function createAndLink(
  slot: LinkSlot,
  kind: "note" | "folder",
  title: string,
  set: LinkSetter,
): Promise<void> {
  try {
    const path = await api.kbCreateTarget(kind, slot.defaultDir(), slot.defaultName(title));
    await set(path);
  } catch (e) {
    showError(e);
  }
}

/**
 * «Заметка → папка» (ТЗ §4.10): рядом с заметкой `path` создаётся папка
 * (имя — заголовок ноды), заметка переносится в неё, ссылка ставится на папку.
 * Ссылки других нод на заметку Rust переписал — так же правим кэш графа.
 */
export async function convertNoteToFolder(path: string, title: string, set: LinkSetter): Promise<void> {
  try {
    const folder = await api.kbNoteToFolder(path, byTitle(title));
    useGraph.getState().rewriteKbPaths(path, `${folder}/${baseName(path)}`);
    await set(folder);
  } catch (e) {
    showError(e);
  }
}

/** Клик по заполненному полю: заметку открыть, папку раскрыть в дереве «Базы». */
export function openLink(path: string, isDir: boolean) {
  useMode.getState().openInKb(isDir ? { kind: "reveal", path } : { kind: "open", path });
}

/** «Показать в проводнике». */
export async function revealLinkInOs(path: string): Promise<void> {
  try {
    const abs = await api.vaultAbsPath(path);
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(abs);
  } catch (e) {
    showError(e);
  }
}
