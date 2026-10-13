// Короткое информационное уведомление (не ошибка): «Обновлено ссылок: 3».
// Отдельный DOM-элемент, чтобы не зависеть от тоста ошибок графа.

let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showNotice(text: string, ms = 3500) {
  if (!el) {
    el = document.createElement("div");
    el.className = "app-notice";
    el.setAttribute("role", "status");
    el.addEventListener("click", () => el?.classList.remove("is-visible"));
    document.body.append(el);
  }
  el.textContent = text;
  // Перезапуск анимации появления.
  el.classList.remove("is-visible");
  void el.offsetWidth;
  el.classList.add("is-visible");
  clearTimeout(timer);
  timer = setTimeout(() => el?.classList.remove("is-visible"), ms);
}
