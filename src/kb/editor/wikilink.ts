// Вики-ссылки Obsidian `[[цель#заголовок|псевдоним]]`: узел синтаксиса для
// @lezer/markdown, автодополнение после `[[` и автозакрытие `]]`.

import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

import { linkText, noteName, parentDir } from "../paths";

const BANG = 33; // !
const OPEN = 91; // [
const CLOSE = 93; // ]

/** Инлайн-узел `WikiLink` (с `WikiLinkMark` на `[[` и `]]`). */
export const WikiLinkSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: tags.link },
    { name: "WikiLinkMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        // `![[…]]` — встраивание: узел включает ведущий `!` (иначе его перехватит Image).
        const embed = next === BANG && cx.char(pos + 1) === OPEN && cx.char(pos + 2) === OPEN;
        if (!embed && (next !== OPEN || cx.char(pos + 1) !== OPEN)) return -1;
        const open = embed ? pos + 3 : pos + 2;
        for (let i = open; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10 || c === OPEN) return -1;
          if (c === CLOSE) {
            if (cx.char(i + 1) !== CLOSE || i === open) return -1;
            return cx.addElement(
              cx.elt("WikiLink", pos, i + 2, [
                cx.elt("WikiLinkMark", pos, open),
                cx.elt("WikiLinkMark", i, i + 2),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

export interface CompletionCtx {
  notes: () => string[];
  source: () => string;
}

/** Автодополнение имён заметок после `[[` (до `|`, `#`, `]`). */
export function wikiCompletion(ctx: CompletionCtx) {
  return (c: CompletionContext): CompletionResult | null => {
    const m = c.matchBefore(/\[\[[^[\]|#\n]*$/);
    if (!m) return null;
    const notes = ctx.notes();
    const source = ctx.source();
    const options: Completion[] = notes
      .filter((p) => p !== source)
      .map((p) => ({
        label: noteName(p),
        detail: parentDir(p) || undefined,
        type: "text",
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          const text = linkText(notes, p, source);
          const hasClose = view.state.sliceDoc(to, to + 2) === "]]";
          view.dispatch({
            changes: { from, to, insert: hasClose ? text : text + "]]" },
            selection: { anchor: from + text.length + 2 },
            userEvent: "input.complete",
          });
        },
      }));
    return { from: m.from + 2, options, validFor: /^[^[\]|#\n]*$/ };
  };
}

/** Второй `[` подряд вставляет `[]]` и открывает автодополнение (как в Obsidian). */
export const autoCloseWiki = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "[" || from !== to) return false;
  if (view.state.sliceDoc(from - 1, from) !== "[") return false;
  if (view.state.sliceDoc(from, from + 2) === "]]") return false;
  view.dispatch({
    changes: { from, to, insert: "[]]" },
    selection: { anchor: from + 1 },
    userEvent: "input.type",
  });
  startCompletion(view);
  return true;
});
