// Открытая заметка вкладки: EditorView, автосохранение, внешние изменения.
//
// Источник правды текста открытой заметки — её EditorView. `saved` — текст,
// который, как мы знаем, лежит на диске. Правила внешних изменений (watcher):
//  - пришёл текст, равный `saved` или текущему тексту, — ничего не делаем
//    (в т.ч. эхо собственной записи; Rust его и так отфильтровывает);
//  - вкладка чистая (текст == saved) — применяем новый текст минимальной
//    правкой (общий префикс/суффикс), курсор и прокрутка остаются на месте;
//  - вкладка «грязная» (несохранённый ввод) — текст не трогаем, вкладка
//    переходит в «конфликт»: автосохранение на паузе, баннер предлагает
//    «Оставить моё» (перезаписать файл) или «Загрузить с диска».

import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { api, isConflictError } from "../api";
import { buildExtensions, refreshDecos, type EditorCtx } from "./editor/setup";

const SAVE_DEBOUNCE_MS = 600;

export interface DocMeta {
  loaded: boolean;
  dirty: boolean;
  /** Файл изменён снаружи, пока были несохранённые правки. */
  conflict: boolean;
  /** Файл удалён/переименован снаружи, а правки не сохранены. */
  missing: boolean;
  error: string | null;
  /** Растёт при каждом изменении текста — для режима чтения и outline. */
  version: number;
}

export const EMPTY_META: DocMeta = {
  loaded: false,
  dirty: false,
  conflict: false,
  missing: false,
  error: null,
  version: 0,
};

export interface DocHooks {
  meta: (id: string, meta: DocMeta) => void;
  notes: () => string[];
  images: () => string[];
  /** Обновить дерево vault (после сохранения вложения). */
  reloadTree: () => Promise<void>;
  openLink: (target: string, source: string, newTab: boolean) => void;
  showError: (e: unknown) => void;
}

/** Куда прокрутить после загрузки. */
export type Reveal = { line: number } | { heading: string } | null;

export class NoteDoc {
  view: EditorView | null = null;
  private saved = "";
  /** mtime файла, соответствующий `saved` (проверка при записи). */
  private mtime: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private meta: DocMeta = { ...EMPTY_META };
  private destroyed = false;
  /** Текст на диске при конфликте. */
  private diskText: string | null = null;
  private diskMtime: number | null = null;

  constructor(
    readonly id: string,
    public path: string,
    private hooks: DocHooks,
  ) {}

  private setMeta(patch: Partial<DocMeta>) {
    this.meta = { ...this.meta, ...patch };
    if (!this.destroyed) this.hooks.meta(this.id, this.meta);
  }

  get text(): string {
    return this.view?.state.doc.toString() ?? this.saved;
  }

  async load(reveal: Reveal = null): Promise<void> {
    try {
      const file = await api.vaultRead(this.path);
      if (this.destroyed) return;
      this.saved = file.content;
      this.mtime = file.mtime;
      const ctx: EditorCtx = {
        source: () => this.path,
        notes: () => this.hooks.notes(),
        images: () => this.hooks.images(),
        afterAttach: () => this.hooks.reloadTree(),
        showError: (e) => this.hooks.showError(e),
        openLink: (target, newTab) => this.hooks.openLink(target, this.path, newTab),
        onChange: () => this.onChange(),
      };
      this.view = new EditorView({
        state: EditorState.create({ doc: file.content, extensions: buildExtensions(ctx) }),
      });
      this.setMeta({ loaded: true, error: null, version: this.meta.version + 1 });
      if (reveal) requestAnimationFrame(() => this.reveal(reveal));
    } catch (e) {
      this.setMeta({ loaded: true, error: String(e) });
    }
  }

  /** Прокрутка к строке/заголовку, курсор туда же. */
  reveal(r: Reveal) {
    const view = this.view;
    if (!view || !r) return;
    const doc = view.state.doc;
    let lineNo: number | null = null;
    if ("line" in r) lineNo = Math.min(Math.max(r.line + 1, 1), doc.lines);
    else {
      const want = r.heading.trim().toLowerCase();
      for (let i = 1; i <= doc.lines; i++) {
        const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(doc.line(i).text);
        if (m && m[1].toLowerCase() === want) {
          lineNo = i;
          break;
        }
      }
    }
    if (lineNo == null) return;
    const line = doc.line(lineNo);
    view.dispatch({
      selection: EditorSelection.cursor(line.to),
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 60 }),
    });
  }

  private onChange() {
    const dirty = this.text !== this.saved;
    this.setMeta({ dirty, version: this.meta.version + 1 });
    if (dirty && !this.meta.conflict && !this.meta.missing) this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  /** Записать текущий текст (если он отличается от диска). */
  async save(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) await this.saving;
    if (!this.view || this.meta.conflict) return;
    const text = this.text;
    if (text === this.saved && !this.meta.missing) {
      this.setMeta({ dirty: false });
      return;
    }
    const path = this.path;
    this.saving = (async () => {
      try {
        // Пропавший файл создаём заново без проверки mtime.
        const expected = this.meta.missing ? null : this.mtime;
        const mtime = await api.vaultWrite(path, text, expected);
        if (path === this.path) {
          this.saved = text;
          this.mtime = mtime;
        }
        this.setMeta({ dirty: this.text !== this.saved, missing: false, error: null });
      } catch (e) {
        if (isConflictError(e)) {
          // Файл изменился снаружи, а событие watcher'а ещё не дошло: не затираем.
          await this.enterConflict();
        } else this.hooks.showError(e);
      }
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  /** Сохранить несохранённое немедленно (перед закрытием, переименованием, уходом). */
  async flush(): Promise<void> {
    if (this.meta.dirty && !this.meta.conflict) await this.save();
    else if (this.saving) await this.saving;
  }

  /** Файл изменился на диске (watcher). */
  async external(): Promise<void> {
    if (!this.view || this.destroyed) return;
    if (this.saving) await this.saving;
    let file: { content: string; mtime: number };
    try {
      file = await api.vaultRead(this.path);
    } catch {
      return; // файл пропал — придёт remove
    }
    if (!this.view || this.meta.conflict) return;
    const { content } = file;
    const current = this.text;
    if (content === this.saved || content === current) {
      this.saved = content;
      this.mtime = file.mtime;
      this.setMeta({ dirty: current !== content, missing: false });
      return;
    }
    if (current === this.saved) {
      this.saved = content;
      this.mtime = file.mtime;
      this.applyText(content);
      this.setMeta({ dirty: false, missing: false, version: this.meta.version + 1 });
    } else {
      this.diskText = content;
      this.diskMtime = file.mtime;
      clearTimeout(this.timer);
      this.setMeta({ conflict: true });
    }
  }

  /** Запись отклонена (файл изменён снаружи): перечитать диск и показать конфликт. */
  private async enterConflict(): Promise<void> {
    try {
      const file = await api.vaultRead(this.path);
      if (file.content === this.text) {
        this.saved = file.content;
        this.mtime = file.mtime;
        this.setMeta({ dirty: false });
        return;
      }
      this.diskText = file.content;
      this.diskMtime = file.mtime;
      clearTimeout(this.timer);
      this.setMeta({ conflict: true });
    } catch (e) {
      this.hooks.showError(e);
    }
  }

  /** Конфликт: `mine` — перезаписать файл своим текстом, иначе взять текст с диска. */
  async resolveConflict(mine: boolean): Promise<void> {
    const disk = this.diskText;
    this.diskText = null;
    this.setMeta({ conflict: false });
    const diskMtime = this.diskMtime;
    this.diskMtime = null;
    if (mine) {
      this.saved = disk ?? this.saved;
      this.mtime = diskMtime ?? this.mtime;
      await this.save();
    } else if (disk != null) {
      this.saved = disk;
      this.mtime = diskMtime ?? this.mtime;
      this.applyText(disk);
      this.setMeta({ dirty: false, version: this.meta.version + 1 });
    }
  }

  /** Файл исчез снаружи, а правки не сохранены: вкладка остаётся, сохранение создаст файл заново. */
  markMissing() {
    clearTimeout(this.timer);
    this.setMeta({ missing: true });
  }

  isDirty() {
    return this.meta.dirty;
  }

  /** Заменить текст минимальной правкой — курсор вне правки не прыгает. */
  private applyText(next: string) {
    const view = this.view;
    if (!view) return;
    const cur = view.state.doc.toString();
    let start = 0;
    const max = Math.min(cur.length, next.length);
    while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endCur = cur.length;
    let endNext = next.length;
    while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
      endCur--;
      endNext--;
    }
    view.dispatch({
      changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
      annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
    });
  }

  /** Список заметок изменился — перерисовать ссылки (найдена/не найдена). */
  refreshLinks() {
    this.view?.dispatch({ effects: refreshDecos.of(null) });
  }

  async destroy(): Promise<void> {
    await this.flush();
    this.destroyed = true;
    clearTimeout(this.timer);
    this.view?.destroy();
    this.view = null;
  }
}
