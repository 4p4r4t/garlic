// Режим окна: «Граф» или «База» (ТЗ §4.10). Оба режима остаются смонтированными
// (граф — скрыт через visibility), поэтому камера, слои, вкладки и курсоры
// переживают переключение. Режим «База» грузится лениво при первом входе.

import { create } from "zustand";

import { api, APP_STATE, type LinkedNode } from "../api";
import { cameraFocus } from "../layers/CameraFocus";
import { useGraph } from "./graph";

export type AppMode = "graph" | "kb";

/** Запрос к режиму «База» снаружи (из графа, M5.2): открыть заметку / показать в дереве. */
export type KbRequest =
  | { kind: "open"; path: string; newTab?: boolean }
  | { kind: "reveal"; path: string };

interface ModeState {
  mode: AppMode;
  /** Режим «База» хоть раз открывали — его чанк загружен и смонтирован. */
  kbMounted: boolean;
  /** Необработанный запрос к «Базе» (забирает KbMode). */
  kbRequest: KbRequest | null;
  /** Счётчик смен папки vault (настройки) — подписчики перечитывают vault. */
  vaultTick: number;
  bumpVault: () => void;

  init: () => Promise<void>;
  setMode: (mode: AppMode) => void;
  /** Переключиться в «Базу» и открыть заметку / раскрыть папку в дереве. */
  openInKb: (req: KbRequest) => void;
  takeKbRequest: () => KbRequest | null;
}

export const useMode = create<ModeState>()((set, get) => ({
  mode: "graph",
  kbMounted: false,
  kbRequest: null,
  vaultTick: 0,
  bumpVault: () => set({ vaultTick: get().vaultTick + 1 }),

  init: async () => {
    try {
      const saved = await api.getAppState(APP_STATE.mode);
      if (saved === "kb") set({ mode: "kb", kbMounted: true });
    } catch {
      // не критично: остаёмся в графе
    }
  },

  setMode: (mode) => {
    if (get().mode === mode) return;
    set({ mode, kbMounted: get().kbMounted || mode === "kb" });
    void api.setAppState(APP_STATE.mode, mode).catch(() => undefined);
  },

  openInKb: (req) => {
    set({ kbRequest: req });
    get().setMode("kb");
  },

  takeKbRequest: () => {
    const req = get().kbRequest;
    if (req) set({ kbRequest: null });
    return req;
  },
}));

/** Режим «Граф» активен — для обработчиков клавиш графа. */
export const isGraphMode = () => useMode.getState().mode === "graph";

/**
 * Перейти к ноде графа из «Базы» (правая панель «Ноды графа», маркер задачи
 * у результата в проводнике): режим «Граф»,
 * при необходимости смена пространства, проваливание по цепочке слоёв,
 * выделение и камера к ноде.
 */
export async function revealGraphNode(
  node: Pick<LinkedNode, "id" | "spaceId" | "canvasChain">,
): Promise<void> {
  useMode.getState().setMode("graph");
  const graph = useGraph.getState();
  if (graph.activeSpaceId !== node.spaceId) await graph.switchSpace(node.spaceId);
  await useGraph.getState().revealNode(node.canvasChain, node.id);
  const { layers } = useGraph.getState();
  const top = layers[layers.length - 1];
  if (top === node.canvasChain[node.canvasChain.length - 1]) cameraFocus.request(top, node.id);
}
