// Markdown → HTML для режима чтения и таблиц в Live Preview (marked + GFM).
// Сырой HTML из заметок не исполняется (экранируется), ссылки — только
// http(s)/mailto или внутренние; подсветка кода — асинхронно (`highlightIn`).

import { Marked, type Tokens } from "marked";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";

import { parseWiki, resolveLink } from "./paths";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface RenderCtx {
  notes: string[];
  source: string;
}

let ctx: RenderCtx = { notes: [], source: "" };

const SAFE_URL = /^(https?:|mailto:)/i;

const md = new Marked({ gfm: true, breaks: true });

md.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\[\[([^[\]\n]+?)\]\]/.exec(src);
        if (m) return { type: "wikilink", raw: m[0], inner: m[1] };
        return undefined;
      },
      renderer(token) {
        const inner = (token as unknown as { inner: string }).inner;
        const { target, heading, alias } = parseWiki(inner);
        const text = alias ?? (heading ? (target ? `${target} › ${heading}` : heading) : target);
        const ok = !target || resolveLink(ctx.notes, target, ctx.source) != null;
        return `<a class="internal-link${ok ? "" : " is-unresolved"}" data-target="${escapeHtml(inner)}">${escapeHtml(text)}</a>`;
      },
    },
  ],
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      if (SAFE_URL.test(href)) {
        return `<a class="external-link" data-href="${escapeHtml(href)}"${t}>${text}</a>`;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return text; // javascript: и прочее — без ссылки
      let target = href;
      try {
        target = decodeURI(href);
      } catch {
        // оставляем как есть
      }
      return `<a class="internal-link" data-target="${escapeHtml(target)}"${t}>${text}</a>`;
    },
    image({ text, href }: Tokens.Image) {
      return `<span class="rd-image" title="${escapeHtml(href)}">🖼 ${escapeHtml(text || href)}</span>`;
    },
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      return `<pre class="rd-code"><code data-lang="${escapeHtml(l)}">${escapeHtml(text)}</code></pre>`;
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return `<input type="checkbox" class="rd-task"${checked ? " checked" : ""}> `;
    },
  },
});

/** Markdown → HTML (синхронно). `notes`/`source` — для «не найдена» у вики-ссылок. */
export function renderMarkdown(src: string, notes: string[] = [], source = ""): string {
  ctx = { notes, source };
  return md.parse(src, { async: false });
}

/** Подсветка блоков кода внутри `root` (языки грузятся лениво). */
export async function highlightIn(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre.rd-code > code[data-lang]"));
  for (const code of blocks) {
    const name = code.dataset.lang;
    if (!name) continue;
    const desc = LanguageDescription.matchLanguageName(languages, name, true);
    if (!desc) continue;
    try {
      const support = await desc.load();
      const text = code.textContent ?? "";
      const tree = support.language.parser.parse(text);
      const frag = document.createDocumentFragment();
      highlightCode(
        text,
        tree,
        classHighlighter,
        (t, cls) => {
          if (!cls) frag.append(t);
          else {
            const span = document.createElement("span");
            span.className = cls;
            span.textContent = t;
            frag.append(span);
          }
        },
        () => frag.append("\n"),
      );
      if (code.isConnected) code.replaceChildren(frag);
    } catch {
      // без подсветки
    }
  }
}

/** Номера строк исходника с задачами `- [ ]` по порядку (вне блоков кода). */
export function taskLines(src: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  src.split("\n").forEach((line, i) => {
    const t = line.trimStart();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      return;
    }
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fence = t.slice(0, 3);
      return;
    }
    if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) out.push(i);
  });
  return out;
}
