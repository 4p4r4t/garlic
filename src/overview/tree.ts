// Дерево обзора задач (ТЗ §4.6.1) из плоского списка `list_space_tasks`.
//
// Порядок: бэкенд отдаёт задачи по глубине, затем по положению на холсте
// (y, потом x — «как читается холст»: сверху вниз, слева направо), затем по
// времени создания. Соседи в дереве всегда лежат на одном холсте, поэтому
// этот порядок просто сохраняется при раскладке по родителям.

import type { SpaceTask } from "../api";

export interface TreeRow {
  task: SpaceTask;
  /** false — предок, попавший в дерево только как контекст (приглушается). */
  match: boolean;
  children: TreeRow[];
}

/** Задачи, для которых `isMatch`, плюс цепочки их предков. */
export function buildTree(tasks: SpaceTask[], isMatch: (t: SpaceTask) => boolean): TreeRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const included = new Set<string>();
  for (const t of tasks) {
    if (!isMatch(t)) continue;
    let cur: SpaceTask | undefined = t;
    while (cur && !included.has(cur.id)) {
      included.add(cur.id);
      cur = cur.parentNodeId ? byId.get(cur.parentNodeId) : undefined;
    }
  }
  const rows = new Map<string, TreeRow>();
  const roots: TreeRow[] = [];
  for (const t of tasks) {
    if (!included.has(t.id)) continue;
    const row: TreeRow = { task: t, match: isMatch(t), children: [] };
    rows.set(t.id, row);
    // Родитель глубже на уровень — в отсортированном по глубине списке он уже разложен.
    const parent = t.parentNodeId ? rows.get(t.parentNodeId) : undefined;
    (parent ? parent.children : roots).push(row);
  }
  return roots;
}

/** Цепочка холстов от корневого холста пространства до холста задачи. */
export function canvasChain(task: SpaceTask, byId: Map<string, SpaceTask>): string[] {
  const chain = [task.canvasId];
  let parent = task.parentNodeId ? byId.get(task.parentNodeId) : undefined;
  while (parent) {
    chain.unshift(parent.canvasId);
    parent = parent.parentNodeId ? byId.get(parent.parentNodeId) : undefined;
  }
  return chain;
}
