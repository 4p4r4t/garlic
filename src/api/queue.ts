// Последовательная очередь вызовов: команды Tauri асинхронные и могут
// выполниться не в порядке вызова. Все обращения к БД идут строго по очереди,
// чтобы «статус → статус» или «создать → передвинуть» не перепутались.

let tail: Promise<unknown> = Promise.resolve();

export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
