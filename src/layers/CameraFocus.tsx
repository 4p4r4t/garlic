// Подвести общую камеру к ноде (обзор задач, ТЗ §4.6.1).
//
// Камерой владеет верхний уровень стека слоёв (viewportBus), а холст нужной
// ноды может ещё только монтироваться (проваливание через несколько слоёв).
// Поэтому запрос кладётся «в ожидание» с id холста, а исполняет его
// <CameraFocus> того уровня, который показывает этот холст и стал верхним.
// Программный сдвиг React Flow вызывает onMove/onMoveEnd верхнего уровня —
// нижние уровни повторяют камеру, вьюпорт сохраняется как при обычном пане.

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";

interface FocusRequest {
  canvasId: string;
  nodeId: string;
  at: number;
}

/** Зум, ниже которого камера при фокусе приближается до 1 (иначе зум не меняется). */
const MIN_FOCUS_ZOOM = 0.6;
const FOCUS_MS = 320;
/** Запрос, который никто не взял за это время, забывается. */
const STALE_MS = 3000;

let pending: FocusRequest | null = null;
const listeners = new Set<() => void>();

export const cameraFocus = {
  /** Центрировать камеру на ноде `nodeId` холста `canvasId`, когда тот окажется наверху. */
  request(canvasId: string, nodeId: string) {
    pending = { canvasId, nodeId, at: Date.now() };
    listeners.forEach((fn) => fn());
  },
};

function take(canvasId: string): FocusRequest | null {
  if (!pending) return null;
  if (Date.now() - pending.at > STALE_MS) {
    pending = null;
    return null;
  }
  if (pending.canvasId !== canvasId) return null;
  const req = pending;
  pending = null;
  return req;
}

/** Монтируется внутри ReactFlowProvider каждого уровня. */
export function CameraFocus({ canvasId, active }: { canvasId: string; active: boolean }) {
  const { fitView, getViewport } = useReactFlow();

  useEffect(() => {
    if (!active) return;
    const run = () => {
      const req = take(canvasId);
      if (!req) return;
      const zoom = getViewport().zoom;
      const target = zoom < MIN_FOCUS_ZOOM ? 1 : zoom;
      // fitView ждёт замера ноды (свежесмонтированный уровень), зум фиксирован.
      void fitView({
        nodes: [{ id: req.nodeId }],
        minZoom: target,
        maxZoom: target,
        duration: FOCUS_MS,
      });
    };
    run();
    listeners.add(run);
    return () => {
      listeners.delete(run);
    };
  }, [active, canvasId, fitView, getViewport]);

  return null;
}
