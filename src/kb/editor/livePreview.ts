// Live Preview в духе Obsidian: разметка markdown скрыта везде, кроме строк,
// которых касается курсор/выделение. Заголовки крупнее, жирный/курсив/
// зачёркнутый/код оформлены, маркеры списков — точки, задачи — чекбоксы,
// цитаты и блоки кода — с фоном, ссылки — только текст, `---` — линия,
// таблицы — отрисованная таблица (клик — исходник).
//
// Декорации считаются StateField'ом по всему документу: таблицы — блочные
// замены, а их можно отдавать только из поля состояния.

import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { hydrateImages, imageUrl, parseEmbedSize } from "../images";
import { isImage, parseWiki, resolveLink } from "../paths";
import { renderMarkdown } from "../reading";

/** Принудительный пересчёт (изменился список заметок → «не найдена» у ссылок). */
export const refreshDecos = StateEffect.define<null>();

export interface PreviewCtx {
  notes: () => string[];
  /** Картинки vault: цели `![[…]]` и `![](…)`. */
  images: () => string[];
  source: () => string;
}

/** Картинка vault в тексте (`![[img.png|300]]`, `![alt](img.png)`), M6c. */
class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly alt: string,
    readonly width: number | undefined,
    readonly height: number | undefined,
    readonly block: boolean,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return (
      o.path === this.path &&
      o.alt === this.alt &&
      o.width === this.width &&
      o.height === this.height &&
      o.block === this.block
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement(this.block ? "div" : "span");
    wrap.className = this.block ? "cm-lp-image cm-lp-image-block" : "cm-lp-image";
    const img = document.createElement("img");
    img.alt = this.alt;
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    if (this.height) img.style.height = `${this.height}px`;
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", () => wrap.classList.add("is-broken"));
    imageUrl(this.path).then(
      (url) => (img.src = url),
      () => wrap.classList.add("is-broken"),
    );
    wrap.append(img);
    return wrap;
  }
  ignoreEvent(e: Event) {
    // Клик по картинке ставит курсор в её исходник (показывается синтаксис).
    return e.type !== "mousedown";
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.textContent = "•";
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      const m = /\[( |x|X)\]/.exec(line.text.slice(pos - line.from));
      if (!m) return;
      const at = pos + m.index + 1;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle",
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-hr";
    return s;
  }
}

class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(o: CodeLangWidget) {
    return o.lang === this.lang;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-code-lang";
    s.textContent = this.lang;
    return s;
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly notes: string[],
    readonly source: string,
    readonly images: string[],
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table";
    wrap.innerHTML = renderMarkdown(this.src, this.notes, this.source, this.images);
    hydrateImages(wrap);
    return wrap;
  }
  ignoreEvent(e: Event) {
    // Клик по ссылке внутри таблицы обрабатывает редактор (переход), остальное — курсор в исходник.
    return e.type !== "mousedown";
  }
}

const HEADINGS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const INLINE_MARK: Record<string, string> = {
  Emphasis: "cm-lp-em",
  StrongEmphasis: "cm-lp-strong",
  Strikethrough: "cm-lp-strike",
  InlineCode: "cm-lp-code",
};

function build(state: EditorState, ctx: PreviewCtx): DecorationSet {
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const notes = ctx.notes();
  const images = ctx.images();
  const files = [...notes, ...images];
  const source = ctx.source();
  const out: Range<Decoration>[] = [];

  /** Касается ли выделение строк диапазона [from, to]. */
  const touched = (from: number, to: number) => {
    const a = doc.lineAt(from).from;
    const b = doc.lineAt(to).to;
    return ranges.some((r) => r.to >= a && r.from <= b);
  };
  /** Курсор/выделение внутри [from, to] (включительно). */
  const inside = (from: number, to: number) => ranges.some((r) => r.to >= from && r.from <= to);
  const hide = (from: number, to: number) => {
    if (to > from) out.push(Decoration.replace({}).range(from, to));
  };
  const mark = (cls: string, from: number, to: number, attrs?: Record<string, string>) => {
    if (to > from) out.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
  };
  const lineClass = (pos: number, cls: string) =>
    out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  /** Скрыть маркер и пробел после него. */
  const hideWithSpace = (n: SyntaxNode) => {
    let end = n.to;
    if (doc.sliceString(end, end + 1) === " ") end++;
    hide(n.from, end);
  };

  /**
   * Картинка: вне строки курсора заменяет синтаксис (true); в строке курсора
   * синтаксис остаётся, а под строкой показывается превью (false).
   */
  const addImage = (
    from: number,
    to: number,
    path: string,
    alt: string,
    width: number | undefined,
    height: number | undefined,
  ): boolean => {
    if (!touched(from, to)) {
      out.push(
        Decoration.replace({ widget: new ImageWidget(path, alt, width, height, false) }).range(from, to),
      );
      return true;
    }
    out.push(
      Decoration.widget({
        widget: new ImageWidget(path, alt, width, height, true),
        block: true,
        side: 1,
      }).range(doc.lineAt(to).to),
    );
    return false;
  };

  syntaxTree(state).iterate({
    enter: (ref) => {
      const name = ref.name;
      const node = ref.node;

      const level = HEADINGS[name];
      if (level) {
        for (let pos = node.from; pos <= node.to; ) {
          const line = doc.lineAt(pos);
          lineClass(line.from, `cm-lp-h cm-lp-h${level}`);
          pos = line.to + 1;
        }
        if (!touched(node.from, node.to)) {
          for (const m of node.getChildren("HeaderMark")) {
            if (name.startsWith("Setext")) {
              // Подчёркивание `===`/`---` — вся строка.
              const line = doc.lineAt(m.from);
              hide(line.from, line.to);
            } else if (m.from === node.from) hideWithSpace(m);
            else {
              // Закрывающие `##` и пробелы перед ними.
              let from = m.from;
              while (from > node.from && doc.sliceString(from - 1, from) === " ") from--;
              hide(from, m.to);
            }
          }
        }
        return;
      }

      const inlineCls = INLINE_MARK[name];
      if (inlineCls) {
        mark(inlineCls, node.from, node.to);
        return;
      }

      switch (name) {
        case "EmphasisMark":
        case "StrikethroughMark": {
          const parent = node.parent;
          if (parent && !touched(parent.from, parent.to)) hide(node.from, node.to);
          return;
        }
        case "CodeMark": {
          const parent = node.parent;
          if (parent?.name === "InlineCode" && !touched(parent.from, parent.to)) {
            hide(node.from, node.to);
          }
          return;
        }
        case "FencedCode": {
          const first = doc.lineAt(node.from);
          const last = doc.lineAt(node.to);
          const hidden = !touched(node.from, node.to);
          const marks = node.getChildren("CodeMark");
          const closed = marks.length > 1 && doc.lineAt(marks[marks.length - 1].from).number === last.number;
          for (let n = first.number; n <= last.number; n++) {
            const line = doc.line(n);
            let cls = "cm-lp-codeblock";
            if (n === first.number) cls += " cm-lp-codeblock-begin";
            if (n === last.number) cls += " cm-lp-codeblock-end";
            if (hidden && (n === first.number || (closed && n === last.number))) cls += " cm-lp-fence";
            out.push(Decoration.line({ class: cls }).range(line.from));
          }
          if (hidden) {
            const info = node.getChild("CodeInfo");
            const lang = info ? doc.sliceString(info.from, info.to).trim() : "";
            if (first.to > first.from) {
              out.push(
                lang
                  ? Decoration.replace({ widget: new CodeLangWidget(lang) }).range(first.from, first.to)
                  : Decoration.replace({}).range(first.from, first.to),
              );
            }
            if (closed && last.number !== first.number) hide(last.from, last.to);
          }
          return false;
        }
        case "CodeBlock": {
          // Блок кода отступом.
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            out.push(Decoration.line({ class: "cm-lp-codeblock cm-lp-indented" }).range(doc.line(n).from));
          }
          return false;
        }
        case "Blockquote": {
          for (let pos = node.from; pos <= node.to; ) {
            const line = doc.lineAt(pos);
            lineClass(line.from, "cm-lp-quote");
            pos = line.to + 1;
          }
          return;
        }
        case "QuoteMark": {
          if (!touched(node.from, node.to)) hideWithSpace(node);
          return;
        }
        case "ListMark": {
          const item = node.parent;
          const list = item?.parent;
          const task = item?.getChild("Task");
          const marker = task?.getChild("TaskMarker");
          if (marker) {
            const checked = /\[[xX]\]/.test(doc.sliceString(marker.from, marker.to));
            const end = doc.sliceString(marker.to, marker.to + 1) === " " ? marker.to + 1 : marker.to;
            if (!inside(node.from, marker.to)) {
              out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, end));
            }
            if (checked && task) mark("cm-lp-task-done", end, task.to);
            return;
          }
          if (list?.name === "BulletList") {
            if (!touched(node.from, node.to)) {
              out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            } else mark("cm-lp-list-mark", node.from, node.to);
          } else mark("cm-lp-list-number", node.from, node.to);
          return;
        }
        case "HorizontalRule": {
          lineClass(node.from, "cm-lp-hr-line");
          if (!touched(node.from, node.to)) {
            out.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
          }
          return;
        }
        case "Link": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (marks.length < 2 || !url) return;
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          const href = doc.sliceString(url.from, url.to);
          mark("cm-lp-link", textFrom, textTo, { "data-href": href });
          if (!touched(node.from, node.to)) {
            hide(node.from, textFrom);
            hide(textTo, node.to);
          } else {
            mark("cm-lp-link-src", textTo, node.to);
          }
          return;
        }
        case "Image": {
          // `![alt](путь)`: локальная картинка vault -> виджет (вне строки курсора),
          // удалённые адреса не грузим (без сети).
          const url = node.getChild("URL");
          const marks = node.getChildren("LinkMark");
          if (!url || marks.length < 2) return false;
          let href = doc.sliceString(url.from, url.to).trim().replace(/^<|>$/g, "");
          href = href.split("#")[0];
          try {
            href = decodeURI(href);
          } catch {
            // как есть
          }
          if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
          const found = resolveLink(files, href, source);
          if (!found || !isImage(found)) return false;
          const alt = doc.sliceString(marks[0].to, marks[1].from);
          const { width, height } = parseEmbedSize(/^\d+(x\d+)?$/.test(alt) ? alt : null);
          addImage(node.from, node.to, found, /^\d+(x\d+)?$/.test(alt) ? "" : alt, width, height);
          return false;
        }
        case "URL": {
          const p = node.parent?.name;
          if (p === "Link" || p === "Image") return;
          const href = doc.sliceString(node.from, node.to);
          mark("cm-lp-url", node.from, node.to, { "data-href": href });
          return;
        }
        case "Autolink": {
          // <https://…>: угловые скобки прячем.
          if (!touched(node.from, node.to)) {
            for (const m of node.getChildren("LinkMark")) hide(m.from, m.to);
          }
          return;
        }
        case "WikiLink": {
          const embed = doc.sliceString(node.from, node.from + 1) === "!";
          const innerFrom = node.from + (embed ? 3 : 2);
          const innerTo = node.to - 2;
          const inner = doc.sliceString(innerFrom, innerTo);
          const { target, alias } = parseWiki(inner);
          // `![[картинка.png|300]]`: встраивание картинки vault.
          if (embed && target) {
            const found = resolveLink(files, target, source);
            if (found && isImage(found)) {
              const { width, height } = parseEmbedSize(alias);
              if (addImage(node.from, node.to, found, alias && !width ? alias : "", width, height)) {
                return false;
              }
            }
          }
          const ok = !target || resolveLink(files, target, source) != null;
          const cls = ok ? "cm-lp-wikilink" : "cm-lp-wikilink is-unresolved";
          const attrs = { "data-target": inner };
          if (!touched(node.from, node.to)) {
            hide(node.from, innerFrom);
            hide(innerTo, node.to);
            const bar = inner.indexOf("|");
            if (bar >= 0) {
              hide(innerFrom, innerFrom + bar + 1);
              mark(cls, innerFrom + bar + 1, innerTo, attrs);
            } else mark(cls, innerFrom, innerTo, attrs);
          } else {
            mark("cm-lp-wikilink-mark", node.from, innerFrom);
            mark(cls, innerFrom, innerTo, attrs);
            mark("cm-lp-wikilink-mark", innerTo, node.to);
          }
          return false;
        }
        case "Table": {
          if (!touched(node.from, node.to)) {
            const from = doc.lineAt(node.from).from;
            const to = doc.lineAt(node.to).to;
            out.push(
              Decoration.replace({
                widget: new TableWidget(doc.sliceString(from, to), notes, source, images),
                block: true,
              }).range(from, to),
            );
          } else {
            for (let pos = node.from; pos <= node.to; ) {
              const line = doc.lineAt(pos);
              lineClass(line.from, "cm-lp-table-src");
              pos = line.to + 1;
            }
          }
          return false;
        }
        default:
          return;
      }
    },
  });

  return Decoration.set(out, true);
}

/** Поле декораций Live Preview. */
export function livePreview(ctx: PreviewCtx) {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, ctx),
    update(deco, tr) {
      if (
        tr.docChanged ||
        tr.selection ||
        tr.effects.some((e) => e.is(refreshDecos)) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ) {
        return build(tr.state, ctx);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
