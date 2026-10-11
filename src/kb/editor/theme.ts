// Тема редактора в духе Obsidian (тёмная). Классы Live Preview (`cm-lp-*`)
// и подсветки (`tok-*`) — здесь же, чтобы перебить базовую тему CodeMirror.

import { EditorView } from "@codemirror/view";

export const obsidianTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--kb-text)",
      backgroundColor: "transparent",
      fontSize: "16px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--kb-font)",
      lineHeight: "1.6",
      overflowX: "hidden",
    },
    ".cm-content": {
      maxWidth: "var(--kb-line-width)",
      margin: "0 auto",
      padding: "8px 0 45vh",
      caretColor: "var(--kb-caret)",
    },
    ".cm-line": { padding: "0 2px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--kb-caret)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--kb-selection) !important",
    },
    ".cm-selectionMatch": { backgroundColor: "rgba(127, 109, 242, 0.18)" },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine": { backgroundColor: "transparent" },

    // заголовки (размеры Obsidian по умолчанию)
    ".cm-lp-h": { fontWeight: "700", color: "var(--kb-heading)", lineHeight: "1.3" },
    ".cm-lp-h1": { fontSize: "1.802em", paddingTop: "0.45em !important", paddingBottom: "0.15em !important" },
    ".cm-lp-h2": { fontSize: "1.602em", paddingTop: "0.4em !important", paddingBottom: "0.1em !important" },
    ".cm-lp-h3": { fontSize: "1.424em", paddingTop: "0.35em !important" },
    ".cm-lp-h4": { fontSize: "1.266em", paddingTop: "0.3em !important" },
    ".cm-lp-h5": { fontSize: "1.125em", paddingTop: "0.25em !important" },
    ".cm-lp-h6": { fontSize: "1em", paddingTop: "0.2em !important", color: "var(--kb-text-muted)" },
    ".cm-lp-h .tok-heading": { fontWeight: "700" },
    ".tok-heading": { color: "var(--kb-heading)", fontWeight: "700" },

    ".cm-lp-em, .tok-emphasis": { fontStyle: "italic" },
    ".cm-lp-strong, .tok-strong": { fontWeight: "700" },
    ".cm-lp-strike, .tok-strikethrough": { textDecoration: "line-through" },
    ".cm-lp-code": {
      fontFamily: "var(--kb-mono)",
      fontSize: "0.875em",
      color: "var(--kb-code-text)",
      backgroundColor: "var(--kb-code-bg)",
      borderRadius: "4px",
      padding: "0.1em 0.25em",
    },
    ".tok-meta, .tok-processingInstruction": { color: "var(--kb-text-faint)" },

    // ссылки
    ".cm-lp-wikilink, .cm-lp-link, .cm-lp-url": {
      color: "var(--kb-link)",
      cursor: "pointer",
      textDecoration: "underline",
      textDecorationColor: "rgba(166, 148, 255, 0.4)",
      textUnderlineOffset: "2px",
    },
    ".cm-lp-wikilink:hover, .cm-lp-link:hover, .cm-lp-url:hover": {
      textDecorationColor: "var(--kb-link)",
    },
    ".cm-lp-wikilink.is-unresolved": { opacity: "0.65", textDecorationStyle: "dashed" },
    ".cm-lp-wikilink-mark, .cm-lp-link-src": { color: "var(--kb-text-faint)" },
    ".tok-link, .tok-url": { color: "var(--kb-link)" },

    // списки и задачи
    ".cm-lp-bullet": {
      display: "inline-block",
      width: "1ch",
      color: "var(--kb-text-muted)",
      fontWeight: "700",
      transform: "scale(1.3)",
      textAlign: "center",
    },
    ".cm-lp-list-mark, .cm-lp-list-number": { color: "var(--kb-text-muted)" },
    ".cm-lp-task": {
      appearance: "none",
      width: "15px",
      height: "15px",
      margin: "0 6px 0 1px",
      border: "1.5px solid var(--kb-text-faint)",
      borderRadius: "4px",
      verticalAlign: "-2px",
      cursor: "pointer",
      position: "relative",
    },
    ".cm-lp-task:hover": { borderColor: "var(--kb-accent)" },
    ".cm-lp-task:checked": {
      backgroundColor: "var(--kb-accent)",
      borderColor: "var(--kb-accent)",
    },
    ".cm-lp-task:checked::after": {
      content: '""',
      position: "absolute",
      left: "4px",
      top: "1px",
      width: "4px",
      height: "8px",
      border: "solid #fff",
      borderWidth: "0 2px 2px 0",
      transform: "rotate(45deg)",
    },
    ".cm-lp-task-done": { color: "var(--kb-text-faint)", textDecoration: "line-through" },

    // цитаты
    ".cm-lp-quote": {
      borderLeft: "2px solid var(--kb-accent)",
      paddingLeft: "18px !important",
      color: "var(--kb-text)",
    },

    // блоки кода
    ".cm-lp-codeblock": {
      fontFamily: "var(--kb-mono)",
      fontSize: "0.875em",
      backgroundColor: "var(--kb-code-bg)",
      padding: "0 16px !important",
      lineHeight: "1.55",
    },
    ".cm-lp-codeblock-begin": { borderTopLeftRadius: "4px", borderTopRightRadius: "4px", paddingTop: "6px !important" },
    ".cm-lp-codeblock-end": {
      borderBottomLeftRadius: "4px",
      borderBottomRightRadius: "4px",
      paddingBottom: "6px !important",
    },
    ".cm-lp-fence": { fontSize: "0.7em", lineHeight: "1.4", textAlign: "right" },
    ".cm-lp-code-lang": {
      color: "var(--kb-text-faint)",
      fontFamily: "var(--kb-font)",
      fontSize: "1em",
    },
    ".cm-lp-hr-line": { display: "flex", alignItems: "center", minHeight: "1.6em" },
    ".cm-lp-hr": {
      display: "inline-block",
      width: "100%",
      height: "0",
      borderTop: "1px solid var(--kb-border-strong)",
      verticalAlign: "middle",
    },
    ".cm-lp-table-src": { fontFamily: "var(--kb-mono)", fontSize: "0.875em" },
    ".cm-lp-table": { padding: "4px 2px", overflowX: "auto" },

    // подсветка кода (палитра Obsidian)
    ".tok-keyword": { color: "var(--code-keyword)" },
    ".tok-string, .tok-string2": { color: "var(--code-string)" },
    ".tok-number, .tok-bool, .tok-atom, .tok-literal": { color: "var(--code-value)" },
    ".tok-comment": { color: "var(--kb-text-faint)", fontStyle: "italic" },
    ".tok-variableName.tok-definition, .tok-function": { color: "var(--code-function)" },
    ".tok-propertyName": { color: "var(--code-property)" },
    ".tok-typeName, .tok-className, .tok-namespace": { color: "var(--code-tag)" },
    ".tok-operator": { color: "var(--code-operator)" },
    ".tok-punctuation": { color: "var(--kb-text-muted)" },

    // автодополнение
    ".cm-tooltip": {
      backgroundColor: "var(--kb-bg-secondary)",
      border: "1px solid var(--kb-border-strong)",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--kb-font)",
      fontSize: "14px",
      maxHeight: "300px",
      padding: "4px",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "5px 10px !important",
      borderRadius: "5px",
      color: "var(--kb-text)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--kb-hover-strong)",
      color: "var(--kb-text)",
    },
    ".cm-completionDetail": {
      marginLeft: "10px",
      color: "var(--kb-text-faint)",
      fontStyle: "normal",
      fontSize: "12px",
    },
    ".cm-completionMatchedText": { textDecoration: "none", color: "var(--kb-accent-text)", fontWeight: "600" },

    // панель поиска Ctrl+F
    ".cm-panels": {
      backgroundColor: "var(--kb-bg-secondary)",
      color: "var(--kb-text)",
      borderColor: "var(--kb-border)",
    },
    ".cm-panels-top": { borderBottom: "1px solid var(--kb-border)" },
    ".cm-search": { fontFamily: "var(--kb-font)", fontSize: "13px", padding: "6px 10px" },
    ".cm-search input, .cm-search button": { fontSize: "13px" },
    ".cm-textfield": {
      backgroundColor: "var(--kb-bg)",
      border: "1px solid var(--kb-border-strong)",
      borderRadius: "5px",
      color: "var(--kb-text)",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--kb-hover-strong)",
      border: "0",
      borderRadius: "5px",
      color: "var(--kb-text)",
    },
    ".cm-searchMatch": { backgroundColor: "rgba(229, 192, 123, 0.3)" },
    ".cm-searchMatch-selected": { backgroundColor: "rgba(229, 192, 123, 0.6)" },
  },
  { dark: true },
);
