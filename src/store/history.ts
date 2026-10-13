// Undo/Redo графа (ТЗ M6a). История — в памяти, отдельно на каждое
// пространство, до HISTORY_LIMIT шагов; новый шаг очищает redo.
//
// Устроено как тонкая обёртка над действиями стора графа: `installHistory()`
// подменяет createNode / updateNode / queueMove / connect / persistDelete /
// setStatusMany / … версиями, которые после исходного действия записывают
// шаг с парой «отменить / повторить». Отмена и повтор идут прямо в команды
// Tauri (не через стор — ничего не записывается повторно), затем холсты стека
// слоёв перечитываются из БД (с сохранением выделения и размеров нод), а
// просвечивание и бейджи — вместе с ними.
//
// Удаление нод и стрелок: перед удалением — снимок `snapshot_graph` (ноды с
// поддеревьями подзадач всех уровней и всеми касающимися их связями), отмена —
// `restore_graph` с теми же id. Создание — наоборот: отмена снимает снимок и
// удаляет, повтор восстанавливает (те же id — последующие шаги остаются верны).
//
// Файлы базы знаний не откатываются никогда: шаги ссылок меняют только поле
// ноды; отмена создания ноды-заметки убирает ноду, а её .md остаётся в базе;
// переименование ноды-заметки (= переименование файла) в историю не пишется.
//
// Отмена шага холста, который не открыт: шаг применяется, перечитываются
// открытые уровни и просвечивание, камера и слои не трогаются (в подсказке —
// «на другом уровне»). Если отмена убрала задачу, в слое которой мы стоим,
// стек слоёв опускается до ближайшего существующего уровня.

import { create } from "zustand";

import {
  api,
  type GraphSnapshot,
  type NodeKind,
  type NodeModel,
  type NodePatch,
  type NodePosition,
  type RegionChange,
  type TaskStatus,
} from "../api";
import { useGraph } from "./graph";
import { useMode } from "./mode";

/** Глубина истории на пространство. */
export const HISTORY_LIMIT = 200;
/** Повторные правки того же поля той же ноды (статус, цвет) чаще этого — один шаг. */
const COALESCE_MS = 1500;
const HINT_MS = 2200;

interface Step {
  /** «удаление 3 нод», «статус», … — для подсказки. */
  label: string;
  /** Холсты, которых касается шаг (подсказка «на другом уровне»). */
  canvasIds: string[];
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Ключ склейки: следующий шаг с тем же ключом поглощается (см. `absorb`). */
  key?: string;
  at: number;
  /** Поглотить более поздний шаг с тем же ключом; true — шаг стал пустым (удалить). */
  absorb?: (later: Step) => boolean;
  /** Шаг изменения полей ноды: значения до и после (для склейки). */
  patch?: { before: NodePatch; after: NodePatch };
}

interface Stacks {
  undo: Step[];
  redo: Step[];
}

interface HistoryState {
  /** Подсказка внизу экрана («Отменено: …»); id — чтобы перезапускать анимацию. */
  hint: { id: number; text: string } | null;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const stacks = new Map<string, Stacks>();
/** Шаги, записанные внутри `group` (например, «нода + стрелка к ней»). */
let group: Step[] | null = null;
/** Отмена/повтор выполняются строго по очереди. */
let running: Promise<void> = Promise.resolve();
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let hintSeq = 0;
/** Где нода была до начала драга (id → позиция). */
const dragOrigin = new Map<string, { x: number; y: number }>();

const graph = () => useGraph.getState();

function stacksOf(spaceId: string): Stacks {
  let s = stacks.get(spaceId);
  if (!s) stacks.set(spaceId, (s = { undo: [], redo: [] }));
  return s;
}

function record(step: Step) {
  if (group) {
    group.push(step);
    return;
  }
  const spaceId = graph().activeSpaceId;
  if (!spaceId) return;
  const s = stacksOf(spaceId);
  s.redo = [];
  const top = s.undo[s.undo.length - 1];
  if (step.key && top?.key === step.key && top.absorb && step.at - top.at < COALESCE_MS) {
    if (top.absorb(step)) s.undo.pop();
    else top.at = step.at;
    return;
  }
  s.undo.push(step);
  if (s.undo.length > HISTORY_LIMIT) s.undo.splice(0, s.undo.length - HISTORY_LIMIT);
}

/** Несколько записанных шагов — один шаг истории. */
export async function grouped<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (group) return fn(); // уже внутри группы
  const steps: Step[] = [];
  group = steps;
  try {
    return await fn();
  } finally {
    group = null;
    finishGroup(label, steps);
  }
}

function finishGroup(label: string, steps: Step[]) {
  if (steps.length === 1) record(steps[0]);
  else if (steps.length > 1) {
    record({
      label,
      canvasIds: [...new Set(steps.flatMap((s) => s.canvasIds))],
      at: Date.now(),
      undo: async () => {
        for (const s of [...steps].reverse()) await s.undo();
      },
      redo: async () => {
        for (const s of steps) await s.redo();
      },
    });
  }
}

/**
 * Синхронная группа: шаги, записанные внутри `fn` (например, перемещение нод
 * разных холстов одним драгом, ТЗ §4.12.2), — один шаг истории.
 */
export function groupSync(label: string, fn: () => void) {
  if (group) {
    fn();
    return;
  }
  const steps: Step[] = [];
  group = steps;
  try {
    fn();
  } finally {
    group = null;
    finishGroup(label, steps);
  }
}

/** Откуда начато перемещение ноды, которую двигают не мышью, а «за компанию» (подзадачи). */
export function noteOrigin(id: string, pos: { x: number; y: number }) {
  if (!dragOrigin.has(id)) dragOrigin.set(id, { ...pos });
}

// ---------- шаги ----------

/** Шаг перестройки дерева (ТЗ §4.12.3): область холстов до/после. */
function regionStep(label: string, change: RegionChange): Step {
  return {
    label,
    canvasIds: change.after.region,
    at: Date.now(),
    undo: () => api.applyRegion(change.before),
    redo: () => api.applyRegion(change.after),
  };
}

/**
 * Шаг «элементы появились» (создание) или «исчезли» (удаление): переход между
 * «есть» и «нет» через снимок. `snap` — снимок, если элементы сейчас удалены.
 */
function presenceStep(
  label: string,
  canvasIds: string[],
  nodeIds: string[],
  edgeIds: string[],
  createdNow: boolean,
  snap: GraphSnapshot | null,
): Step {
  let saved = snap;
  const remove = async () => {
    saved = await api.snapshotGraph(nodeIds, edgeIds);
    if (edgeIds.length) await api.deleteEdges(edgeIds);
    if (nodeIds.length) await api.deleteNodes(nodeIds);
  };
  const restore = async () => {
    if (!saved) throw new Error("нет снимка для восстановления");
    await api.restoreGraph(saved);
  };
  return {
    label,
    canvasIds,
    at: Date.now(),
    undo: createdNow ? remove : restore,
    redo: createdNow ? restore : remove,
  };
}

const PATCH_LABELS: Partial<Record<keyof NodePatch, string>> = {
  title: "переименование",
  status: "статус",
  color: "цвет",
  kbResultPath: "ссылка «Результат»",
};

function patchLabel(kind: NodeKind, patch: NodePatch): string {
  const key = Object.keys(patch)[0] as keyof NodePatch | undefined;
  if (key === "kbPath") return kind === "task" ? "ссылка «Комментарий»" : "ссылка заметки";
  return (key && PATCH_LABELS[key]) ?? "изменение ноды";
}

function samePatch(a: NodePatch, b: NodePatch): boolean {
  return Object.keys(a).every(
    (k) => a[k as keyof NodePatch] === b[k as keyof NodePatch],
  );
}

/** Шаг изменения полей ноды: before → after (только изменённые поля). */
function patchStep(
  model: NodeModel,
  before: NodePatch,
  after: NodePatch,
  coalesce: boolean,
): Step {
  const state = { before, after };
  const keys = Object.keys(after).sort().join(",");
  return {
    label: patchLabel(model.kind, after),
    canvasIds: [model.canvasId],
    at: Date.now(),
    key: coalesce ? `${model.id}:${keys}` : undefined,
    absorb: coalesce
      ? (later) => {
          if (!later.patch) return false;
          state.after = later.patch.after;
          // Статус прокрутили по кругу до исходного — шага больше нет.
          return samePatch(state.before, state.after);
        }
      : undefined,
    undo: async () => void (await api.updateNode(model.id, state.before)),
    redo: async () => void (await api.updateNode(model.id, state.after)),
    patch: state,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

// ---------- применение ----------

/** После undo/redo: перечитать уровни стека, просвечивание; исчезнувший слой — закрыть. */
const refreshOpen = () => graph().reloadOpen();

function showHint(text: string) {
  clearTimeout(hintTimer);
  useHistory.setState({ hint: { id: ++hintSeq, text } });
  hintTimer = setTimeout(() => useHistory.setState({ hint: null }), HINT_MS);
}

function apply(dir: "undo" | "redo"): Promise<void> {
  const run = running.then(async () => {
    const spaceId = graph().activeSpaceId;
    if (!spaceId) return;
    const s = stacksOf(spaceId);
    const from = dir === "undo" ? s.undo : s.redo;
    const to = dir === "undo" ? s.redo : s.undo;
    const step = from.pop();
    if (!step) {
      showHint(dir === "undo" ? "Нечего отменять" : "Нечего повторять");
      return;
    }
    // Отложенные перемещения — в БД раньше отмены (иначе догонят и перепишут).
    graph().flushWrites();
    try {
      await step[dir]();
      step.at = 0; // отменённый/повторённый шаг больше не склеивается
      to.push(step);
      const elsewhere = !step.canvasIds.some((c) => graph().layers.includes(c));
      showHint(
        `${dir === "undo" ? "Отменено" : "Повторено"}: ${step.label}${elsewhere ? " (на другом уровне)" : ""}`,
      );
    } catch (e) {
      // Шаг применить нельзя (например, его холст уже удалён) — он выбывает.
      graph().showError(e);
    }
    await refreshOpen();
  });
  running = run.catch(() => undefined);
  return run;
}

export const useHistory = create<HistoryState>()(() => ({
  hint: null,
  undo: () => apply("undo"),
  redo: () => apply("redo"),
}));

// ---------- обёртки действий стора графа ----------

let installed = false;

/** Подключить историю к стору графа и горячие клавиши. Вызывается один раз до рендера. */
export function installHistory() {
  if (installed) return;
  installed = true;
  const orig = { ...graph() };
  const modelOf = (canvasId: string, id: string) =>
    graph().canvases[canvasId]?.nodes.find((n) => n.id === id)?.data.model;

  useGraph.setState({
    onNodesChange: (canvasId, changes) => {
      // Начало драга: запомнить, откуда двигаем (шаг пишется в queueMove).
      const view = graph().canvases[canvasId];
      for (const c of changes) {
        if (c.type !== "position" || !c.dragging || dragOrigin.has(c.id)) continue;
        const n = view?.nodes.find((x) => x.id === c.id);
        if (n) dragOrigin.set(c.id, { ...n.position });
      }
      orig.onNodesChange(canvasId, changes);
    },

    queueMove: (canvasId, positions) => {
      orig.queueMove(canvasId, positions);
      const from: NodePosition[] = [];
      const to: NodePosition[] = [];
      for (const p of positions) {
        const o = dragOrigin.get(p.id);
        dragOrigin.delete(p.id);
        if (o && (o.x !== p.x || o.y !== p.y)) {
          from.push({ id: p.id, x: o.x, y: o.y });
          to.push(p);
        }
      }
      if (!from.length) return;
      // Групповой драг приходит одним вызовом — один шаг.
      record({
        label: from.length === 1 ? "перемещение" : `перемещение ${from.length} нод`,
        canvasIds: [canvasId],
        at: Date.now(),
        undo: () => api.moveNodes(from),
        redo: () => api.moveNodes(to),
      });
    },

    createNode: async (canvasId, kind, pos) => {
      const model = await orig.createNode(canvasId, kind, pos);
      if (model) {
        record(
          presenceStep(
            kind === "task" ? "создание задачи" : "создание заметки",
            [canvasId],
            [model.id],
            [],
            true,
            null,
          ),
        );
      }
      return model;
    },

    createConnectedNode: (canvasId, kind, pos, from, targetHandle) =>
      grouped(kind === "task" ? "создание задачи со стрелкой" : "создание заметки со стрелкой", () =>
        orig.createConnectedNode(canvasId, kind, pos, from, targetHandle),
      ),

    connect: async (canvasId, ends) => {
      const had = new Set(graph().canvases[canvasId]?.edges.map((e) => e.id));
      await orig.connect(canvasId, ends);
      const edge = graph().canvases[canvasId]?.edges.find(
        (e) => !had.has(e.id) && e.source === ends.source && e.target === ends.target,
      );
      if (edge) record(presenceStep("стрелка", [canvasId], [], [edge.id], true, null));
    },

    persistDelete: async (canvasId, nodeIds, edgeIds) => {
      // Снимок встаёт в очередь команд раньше удаления (и после отложенных перемещений).
      graph().flushWrites();
      const snapP = api.snapshotGraph(nodeIds, edgeIds);
      const done = orig.persistDelete(canvasId, nodeIds, edgeIds);
      let snap: GraphSnapshot;
      try {
        snap = await snapP;
      } catch {
        await done;
        return;
      }
      await done;
      // Удалилось ли на самом деле (ошибку уже показал исходный persistDelete)?
      const view = graph().canvases[canvasId];
      if (view?.nodes.some((n) => nodeIds.includes(n.id))) return;
      const roots = snap.nodes.filter((n) => nodeIds.includes(n.id));
      let label: string;
      if (roots.length === 1) label = `удаление «${roots[0].title || "без названия"}»`;
      else if (roots.length > 1) label = `удаление ${roots.length} нод`;
      else if (!snap.edges.length) return;
      else label = `удаление ${plural(snap.edges.length, "стрелки", "стрелок")}`;
      record(
        presenceStep(
          label,
          [...new Set([canvasId, ...snap.canvases.map((c) => c.id)])],
          nodeIds,
          edgeIds,
          false,
          snap,
        ),
      );
    },

    updateNode: async (canvasId, id, patch) => {
      const m = modelOf(canvasId, id);
      // Заголовок ноды-заметки — имя её .md: файлы базы undo не трогает.
      const track = m && !(m.kind === "note" && "title" in patch);
      const keys = Object.keys(patch) as (keyof NodePatch)[];
      const before: NodePatch = {};
      if (track) for (const k of keys) Object.assign(before, { [k]: m[k as keyof NodeModel] });
      await orig.updateNode(canvasId, id, patch);
      if (!track) return;
      const now = modelOf(canvasId, id);
      if (!now) return;
      const after: NodePatch = {};
      for (const k of keys) Object.assign(after, { [k]: now[k as keyof NodeModel] });
      // Ошибка (холст перечитан, значение прежнее) или ничего не поменялось.
      if (samePatch(before, after)) return;
      const coalesce = keys.length === 1 && (keys[0] === "status" || keys[0] === "color");
      record(patchStep(m, before, after, coalesce));
    },

    setStatusMany: async (canvasId, ids, status) => {
      const want = new Set(ids);
      const before = new Map<string, TaskStatus>();
      for (const n of graph().canvases[canvasId]?.nodes ?? []) {
        const st = n.data.model.status;
        if (want.has(n.id) && n.data.model.kind === "task" && st && st !== status) before.set(n.id, st);
      }
      await orig.setStatusMany(canvasId, ids, status);
      const changed = [...before.keys()].filter((id) => modelOf(canvasId, id)?.status === status);
      if (!changed.length) return;
      record({
        label: changed.length === 1 ? "статус" : `статус ${changed.length} задач`,
        canvasIds: [canvasId],
        at: Date.now(),
        undo: async () => {
          const byStatus = new Map<TaskStatus, string[]>();
          for (const id of changed) {
            const st = before.get(id)!;
            byStatus.set(st, [...(byStatus.get(st) ?? []), id]);
          }
          for (const [st, list] of byStatus) await api.setStatusMany(list, st);
        },
        redo: async () => void (await api.setStatusMany(changed, status)),
      });
    },

    setTaskStatus: async (canvasId, id, status, ownerId) => {
      // Холст в кэше — пойдёт через updateNode (там и запишется).
      if (graph().canvases[canvasId]) return orig.setTaskStatus(canvasId, id, status, ownerId);
      let old: NodeModel | undefined;
      try {
        old = (await api.loadCanvas(canvasId)).nodes.find((n) => n.id === id);
      } catch {
        old = undefined;
      }
      await orig.setTaskStatus(canvasId, id, status, ownerId);
      if (old?.status && old.status !== status) {
        record(patchStep(old, { status: old.status }, { status }, true));
      }
    },

    deleteWith: async (ids, edgeIds, mode) => {
      const titles = ids
        .map((id) => Object.values(graph().canvases).flatMap((v) => v.nodes).find((n) => n.id === id))
        .filter(Boolean)
        .map((n) => n!.data.model.title || "без названия");
      const change = await orig.deleteWith(ids, edgeIds, mode);
      if (change) {
        const what = titles.length === 1 ? `удаление «${titles[0]}»` : `удаление ${ids.length} нод`;
        const how = mode === "lift" ? "подзадачи — на уровень выше" : "слой без родителя";
        record(regionStep(`${what} (${how})`, change));
      }
      return change;
    },

    moveIntoTask: async (ids, target) => {
      const t = Object.values(graph().canvases)
        .flatMap((v) => v.nodes)
        .find((n) => n.id === target)?.data.model.title;
      const change = await orig.moveIntoTask(ids, target);
      if (change) {
        const what = ids.length === 1 ? "перенос" : `перенос ${ids.length} нод`;
        record(regionStep(t ? `${what} в «${t}»` : `${what} в задачу`, change));
      }
      return change;
    },

    deleteSpace: async (spaceId) => {
      await orig.deleteSpace(spaceId);
      if (!graph().spaces.some((sp) => sp.id === spaceId)) stacks.delete(spaceId);
    },
  });

  window.addEventListener("keydown", onKeyDown);
}

/** Поле ввода, CodeMirror, contenteditable — там Ctrl+Z свой (текстовый). */
function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  return !!t.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor',
  );
}

function onKeyDown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // По e.code — работает и в русской раскладке (Ctrl+Я).
  const isZ = e.code === "KeyZ";
  const isY = e.code === "KeyY" && !e.shiftKey;
  if (!isZ && !isY) return;
  if (useMode.getState().mode !== "graph") return; // «База» — нативный undo
  if (isTextTarget(e.target) || isTextTarget(document.activeElement)) return;
  if (useGraph.getState().phase !== "ready" || useGraph.getState().editingNodeId) return;
  e.preventDefault();
  if (isY || e.shiftKey) void useHistory.getState().redo();
  else void useHistory.getState().undo();
}
