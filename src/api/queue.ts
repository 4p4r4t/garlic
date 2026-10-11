// Последовательная очередь вызовов: команды Tauri асинхронные и могут
// выполниться не в порядке вызова. Все обращения к БД идут строго по очереди,
// чтобы «статус → статус» или «создать → передвинуть» не перепутались.

/** Отдельная очередь: вызовы одной очереди выполняются строго по порядку. */
export function makeQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Очередь графа (БД). */
export const serial = makeQueue();
/**
 * Очередь изменений базы знаний (запись, создание, переименование…): свои,
 * чтобы долгий поиск/запись файла не задерживали граф и наоборот.
 */
export const serialVault = makeQueue();
