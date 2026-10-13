// Картинки заметок (M6c): загрузка из vault, вставка из буфера и перетаскиванием.
//
// Способ загрузки: Rust-команда `vault_read_image` отдаёт сырые байты (IPC без
// base64), здесь из них делается Blob и `blob:`-URL. Asset-протокол Tauri не
// используется: корень vault динамический (меняется в настройках), а команда сама
// проверяет «путь внутри vault + расширение картинки». SVG показывается только
// через `<img>`, поэтому скрипты в нём не исполняются.

import { create } from "zustand";

import { api } from "../api";
import { baseName, fileLinkText, isImage } from "./paths";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "image/png";

/** Растёт при изменении/удалении/переименовании картинок — виды перечитывают. */
export const useImageRev = create<{ rev: number }>(() => ({ rev: 0 }));

const cache = new Map<string, Promise<string>>();

/** `blob:`-URL картинки vault (кэшируется по пути до инвалидации). */
export function imageUrl(path: string): Promise<string> {
  let hit = cache.get(path);
  if (!hit) {
    hit = api
      .vaultReadImage(path)
      .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) })));
    // Ошибка не кэшируется: повторная попытка при следующем показе.
    hit.catch(() => cache.delete(path));
    cache.set(path, hit);
  }
  return hit;
}

/** Сбросить кэш путей (файл или папка с картинками изменены/удалены/переименованы). */
export function invalidateImages(paths: string[]) {
  let any = false;
  for (const [key, hit] of cache) {
    if (!paths.some((p) => key === p || key.startsWith(p + "/"))) continue;
    any = true;
    cache.delete(key);
    void hit.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
  if (any) useImageRev.setState((s) => ({ rev: s.rev + 1 }));
}

/** Загружает `img[data-vault-src]` внутри `root` (режим чтения, таблицы). */
export function hydrateImages(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>("img[data-vault-src]").forEach((img) => {
    const path = img.dataset.vaultSrc;
    if (!path) return;
    imageUrl(path).then(
      (url) => {
        if (img.isConnected) img.src = url;
      },
      () => img.classList.add("is-broken"),
    );
  });
}

/** Размер из алиаса встраивания: `300` или `300x200` → ширина/высота. */
export function parseEmbedSize(alias: string | null): { width?: number; height?: number } {
  const m = /^\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/.exec(alias ?? "");
  if (!m) return {};
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `Pasted image YYYYMMDDHHmmss` — имя вставленной картинки, как в Obsidian. */
export function pastedImageName(ext: string, now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Картинки из буфера/перетаскивания (по MIME или расширению имени). */
export function imageFiles(files: FileList | File[] | null | undefined): File[] {
  return Array.from(files ?? []).filter((f) => f.type in EXT_BY_MIME || isImage(f.name));
}

/**
 * Сохранить файлы в папку вложений. `keepName` — перетаскивание (имя файла как есть);
 * иначе (буфер) — `Pasted image YYYYMMDDHHmmss.ext`. → пути в vault.
 */
export async function saveImageFiles(files: File[], keepName: boolean): Promise<string[]> {
  const out: string[] = [];
  let tick = 0;
  for (const f of files) {
    const ext = EXT_BY_MIME[f.type] ?? f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase();
    // Несколько вставленных за одну секунду не должны сливаться в одно имя.
    const when = new Date(Date.now() + 1000 * tick++);
    const name = keepName && isImage(f.name) ? baseName(f.name) : pastedImageName(ext, when);
    out.push(await api.vaultSaveAttachment(name, new Uint8Array(await f.arrayBuffer())));
  }
  return out;
}

/** Текст `![[…]]` для сохранённых картинок (имя, если однозначно). */
export function embedText(files: string[], saved: string[], source: string): string {
  return saved.map((p) => `![[${fileLinkText(files, p, source)}]]`).join("\n");
}
