// Набор расширений CodeMirror для заметки базы знаний.

import { autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";

import { livePreview, refreshDecos } from "./livePreview";
import { obsidianTheme } from "./theme";
import { autoCloseWiki, wikiCompletion, WikiLinkSyntax } from "./wikilink";

export { refreshDecos };

export interface EditorCtx {
  /** Путь заметки (меняется при переименовании). */
  source: () => string;
  notes: () => string[];
  /** Переход по ссылке: вики-цель/путь, `newTab` — Ctrl+клик. */
  openLink: (target: string, newTab: boolean) => void;
  onChange: () => void;
}

/** Внешняя ссылка — в браузере по умолчанию. */
export async function openExternal(url: string) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * Клик по ссылке: в отрисованной строке (разметка скрыта) — обычный клик,
 * в строке с курсором (исходник) — Ctrl+клик. Ctrl — в новой вкладке.
 */
function linkClicks(ctx: EditorCtx): Extension {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0) return false;
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-target], .cm-lp-link, .cm-lp-url, .cm-lp-table a",
      );
      if (!el || !view.contentDOM.contains(el)) return false;
      const mod = e.ctrlKey || e.metaKey;
      const inTable = !!el.closest(".cm-lp-table");
      if (!inTable) {
        const pos = view.posAtDOM(el);
        const line = view.state.doc.lineAt(pos);
        const raw = view.state.selection.ranges.some((r) => r.to >= line.from && r.from <= line.to);
        if (raw && !mod) return false;
      }
      const target = el.dataset.target;
      const href = el.dataset.href;
      if (target != null) {
        e.preventDefault();
        ctx.openLink(target, mod);
        return true;
      }
      if (href) {
        e.preventDefault();
        if (/^(https?:|mailto:)/i.test(href)) void openExternal(href);
        else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          let t = href;
          try {
            t = decodeURI(href);
          } catch {
            // как есть
          }
          ctx.openLink(t, mod);
        }
        return true;
      }
      return false;
    },
  });
}

export function buildExtensions(ctx: EditorCtx): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    indentUnit.of("    "),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [WikiLinkSyntax],
    }),
    syntaxHighlighting(classHighlighter),
    livePreview({ notes: ctx.notes, source: ctx.source }),
    autocompletion({
      override: [wikiCompletion({ notes: ctx.notes, source: ctx.source })],
      icons: false,
      closeOnBlur: true,
    }),
    autoCloseWiki,
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    linkClicks(ctx),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) ctx.onChange();
    }),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off" }),
    obsidianTheme,
  ];
}
