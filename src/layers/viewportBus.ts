// Один вьюпорт на пространство (ТЗ §1): все уровни стека слоёв — отдельные
// экземпляры React Flow, но камера у них общая. Верхний (активный) уровень
// владеет камерой и рассылает её каждый кадр пана/зума; нижние подписаны и
// повторяют её через setViewport. Вне React-состояния — чтобы пан не
// перерисовывал дерево компонентов.

import type { Viewport } from "../api";

type Listener = (vp: Viewport) => void;

const listeners = new Set<Listener>();
let current: Viewport = { x: 0, y: 0, zoom: 1 };
/** Защита от петли: нижний уровень, двигая свою камеру, не должен рассылать её снова. */
let emitting = false;

export const viewportBus = {
  /** Текущая камера — новый уровень монтируется сразу с ней (без скачка). */
  get: (): Viewport => current,
  /** Задать без рассылки: смена пространства (все уровни монтируются заново). */
  reset(vp: Viewport) {
    current = vp;
  },
  emit(vp: Viewport) {
    if (emitting) return;
    current = vp;
    emitting = true;
    try {
      listeners.forEach((fn) => fn(vp));
    } finally {
      emitting = false;
    }
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
