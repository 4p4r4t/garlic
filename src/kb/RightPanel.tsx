// Правая панель режима «База»: обратные ссылки, оглавление (outline) и
// «Ноды графа» — ноды, привязанные к заметке или её папкам (клик — в граф).

import { useEffect, useMemo, useState } from "react";
import { syntaxTree } from "@codemirror/language";
import { Circle, CircleCheck, CircleDot, Link2, ListTree, Network, StickyNote } from "lucide-react";

import { api, type Backlink, type LinkedNode } from "../api";
import { revealGraphNode, useMode } from "../store/mode";
import { ancestors, noteName, parentDir } from "./paths";
import { docs, useDocMeta, useKb, type RightView } from "./store";

const VIEWS: { id: RightView; title: string; icon: React.ReactNode }[] = [
  { id: "backlinks", title: "Обратные ссылки", icon: <Link2 size={16} /> },
  { id: "outline", title: "Оглавление", icon: <ListTree size={16} /> },
  { id: "nodes", title: "Ноды графа", icon: <Network size={16} /> },
];

export function RightPanel() {
  const view = useKb((s) => s.rightView);
  const setView = useKb((s) => s.setRightView);
  const active = useKb((s) => s.tabs.find((t) => t.id === s.activeId) ?? null);
  return (
    <div className="kb-right-inner">
      <div className="kb-nav-header is-tabs">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === view ? "kb-nav-btn is-active" : "kb-nav-btn"}
            title={v.title}
            onClick={() => setView(v.id)}
          >
            {v.icon}
          </button>
        ))}
      </div>
      <div className="kb-pane-title">{VIEWS.find((v) => v.id === view)?.title}</div>
      <div className="kb-right-body">
        {!active ? (
          <div className="kb-empty">Нет открытой заметки</div>
        ) : view === "backlinks" ? (
          <Backlinks path={active.path} tabId={active.id} />
        ) : view === "outline" ? (
          <Outline tabId={active.id} />
        ) : (
          <GraphNodes path={active.path} />
        )}
      </div>
    </div>
  );
}

function Backlinks({ path, tabId }: { path: string; tabId: string }) {
  const [list, setList] = useState<Backlink[] | null>(null);
  const notes = useKb((s) => s.notes);
  const dirty = useDocMeta(tabId).dirty;

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .vaultBacklinks(path)
        .then((l) => alive && setList(l))
        .catch(() => alive && setList([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // dirty: после сохранения других заметок список обновится через notes (дерево).
  }, [path, notes, dirty]);

  if (!list) return null;
  if (!list.length) return <div className="kb-empty">Ссылок на эту заметку нет</div>;
  return (
    <div className="kb-backlinks">
      <div className="kb-section-count">Связанные упоминания · {list.length}</div>
      {list.map((b) => (
        <div key={b.path} className="kb-backlink">
          <div className="kb-backlink-title" onClick={() => void useKb.getState().openNote(b.path)}>
            {noteName(b.path)}
            {parentDir(b.path) && <span className="kb-backlink-dir">{parentDir(b.path)}</span>}
          </div>
          {b.lines.map((l) => (
            <div
              key={l.line}
              className="kb-backlink-line"
              onClick={() => void useKb.getState().openNote(b.path, { reveal: { line: l.line } })}
            >
              {l.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

function Outline({ tabId }: { tabId: string }) {
  const meta = useDocMeta(tabId);
  const reading = useKb((s) => s.tabs.find((t) => t.id === tabId)?.reading ?? false);

  const headings = useMemo<Heading[]>(() => {
    const view = docs.get(tabId)?.view;
    if (!view) return [];
    const out: Heading[] = [];
    const doc = view.state.doc;
    syntaxTree(view.state).iterate({
      enter: (n) => {
        const m = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(n.name);
        if (!m) return n.name === "Document" ? undefined : false;
        const line = doc.lineAt(n.from);
        const text = (n.name.startsWith("ATX") ? line.text.replace(/^#+\s*/, "").replace(/\s+#+\s*$/, "") : line.text).trim();
        out.push({ level: Number(m[1]), text, line: line.number - 1 });
        return false;
      },
    });
    return out;
    // version — перечитать при каждом изменении текста.
  }, [tabId, meta.version, meta.loaded]);

  if (!headings.length) return <div className="kb-empty">Заголовков нет</div>;
  const min = Math.min(...headings.map((h) => h.level));

  const go = (h: Heading, i: number) => {
    if (reading) {
      const pane = document.querySelector(".kb-pane.is-active .kb-reading");
      pane?.querySelectorAll("h1, h2, h3, h4, h5, h6")[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    const doc = docs.get(tabId);
    doc?.reveal({ line: h.line });
    doc?.view?.focus();
  };

  return (
    <div className="kb-outline">
      {headings.map((h, i) => (
        <div
          key={i}
          className="kb-outline-item"
          style={{ paddingLeft: 10 + (h.level - min) * 16 }}
          onClick={() => go(h, i)}
          title={h.text}
        >
          {h.text || "…"}
        </div>
      ))}
    </div>
  );
}

const STATUS_ICON = {
  todo: <Circle size={13} />,
  in_progress: <CircleDot size={13} />,
  done: <CircleCheck size={13} />,
};

/** Ноды графа, привязанные к заметке и к папкам, в которых она лежит. */
function GraphNodes({ path }: { path: string }) {
  const [groups, setGroups] = useState<{ path: string; nodes: LinkedNode[] }[] | null>(null);
  const mode = useMode((s) => s.mode);

  useEffect(() => {
    let alive = true;
    const targets = [path, ...ancestors(path).reverse()];
    Promise.all(targets.map((p) => api.kbLinkedNodes(p).then((nodes) => ({ path: p, nodes }))))
      .then((g) => alive && setGroups(g))
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [path, mode]);

  if (!groups) return null;
  const nonEmpty = groups.filter((g) => g.nodes.length);
  if (!nonEmpty.length) {
    return (
      <div className="kb-empty">
        Нет нод, привязанных к этой заметке или её папкам.
      </div>
    );
  }
  return (
    <div className="kb-graph-nodes">
      {nonEmpty.map((g) => (
        <div key={g.path} className="kb-graph-group">
          <div className="kb-section-count">
            {g.path === path ? "Эта заметка" : `Папка «${noteName(g.path)}»`} · {g.nodes.length}
          </div>
          {g.nodes.map((n) => (
            <div
              key={n.id}
              className={`kb-graph-node status-${n.status ?? "note"}`}
              title={`${n.spaceName} — перейти в граф`}
              onClick={() => void revealGraphNode(n)}
            >
              <span className="kb-graph-node-icon">
                {n.kind === "note" ? <StickyNote size={13} /> : STATUS_ICON[n.status ?? "todo"]}
              </span>
              <span className="kb-graph-node-title">{n.title || "Без названия"}</span>
              <span className="kb-graph-node-space">{n.spaceName}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
