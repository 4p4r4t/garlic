// Стек слоёв подзадач (ТЗ §4.5): каждый уровень — свой экземпляр React Flow,
// уровни лежат друг на друге, между ними — тинт (затемнение). Нижние уровни
// размыты и не получают событий; верхний — прозрачный и полностью
// интерактивный, на нём же нода-родитель (якорь) и просвечивающие уровни.
//
//   уровень 0 (корень, blur) │ тинт │ уровень 1 (blur) │ тинт │ уровень 2 (активный)
//
// Камера общая (viewportBus), поэтому вход/выход её не двигает.

import { memo, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";

import { FlowCanvas } from "../canvas/Canvas";
import { useGraph } from "../store/graph";
import { CameraFocus } from "./CameraFocus";

/** Длительность анимации входа/выхода (ТЗ §4.5: ~200 мс). Зеркало — styles.css. */
export const LAYER_ANIM_MS = 200;

interface StackState {
  layers: string[];
  /** Уровни, которые только что закрыли: доигрывают обратную анимацию. */
  leaving: string[];
}

export function LayerStack() {
  const layers = useGraph((s) => s.layers);
  const exitTo = useGraph((s) => s.exitTo);

  // Производное состояние считается прямо в рендере, чтобы закрываемый
  // уровень не размонтировался ни на кадр до начала обратной анимации.
  const [stack, setStack] = useState<StackState>({ layers, leaving: [] });
  let current = stack;
  if (stack.layers !== layers) {
    const old = stack.layers;
    // Смена пространства (другой корень) — без анимации: старые холсты уже не в кэше.
    const gone = old[0] === layers[0] ? old.filter((id) => !layers.includes(id)) : [];
    current = { layers, leaving: gone };
    setStack(current);
  }
  const { leaving } = current;

  useEffect(() => {
    if (!leaving.length) return;
    const t = setTimeout(
      () => setStack((s) => (s.leaving === leaving ? { ...s, leaving: [] } : s)),
      LAYER_ANIM_MS + 40,
    );
    return () => clearTimeout(t);
  }, [leaving]);

  const rendered = [...layers, ...leaving.filter((id) => !layers.includes(id))];
  const owners = useGraph(
    useShallow((s) => rendered.map((id) => s.canvases[id]?.canvas.ownerNode ?? null)),
  );

  // Esc — выход на уровень ниже (если не занято меню, полем ввода или стрелкой).
  useEffect(() => {
    if (layers.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      if (document.querySelector(".ctx-menu, .node-menu, .spaces-panel, .is-connecting")) return;
      void exitTo(layers.length - 2);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layers.length, exitTo]);

  const top = layers.length - 1;
  return (
    <div className="layer-stack">
      {rendered.map((id, i) => (
        <Level
          key={id}
          canvasId={id}
          index={i}
          active={i === top}
          distance={Math.max(0, top - i)}
          leaving={i > top}
          parentCanvasId={i > 0 ? rendered[i - 1] : undefined}
          coveredNodeId={i < top ? (owners[i + 1] ?? undefined) : undefined}
        />
      ))}
    </div>
  );
}

interface LevelProps {
  canvasId: string;
  index: number;
  active: boolean;
  /** На сколько уровней ниже верхнего (0 — верхний). */
  distance: number;
  leaving: boolean;
  parentCanvasId?: string;
  coveredNodeId?: string;
}

const Level = memo(function Level({
  canvasId,
  index,
  active,
  distance,
  leaving,
  parentCanvasId,
  coveredNodeId,
}: LevelProps) {
  // Только что открытый слой проявляется (ноды/стрелки, кроме якоря).
  const [entering, setEntering] = useState(index > 0);
  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => setEntering(false), LAYER_ANIM_MS + 40);
    return () => clearTimeout(t);
  }, [entering]);

  const cls = [
    "layer-level",
    distance > 0 && `is-under under-${Math.min(distance, 3)}`,
    leaving && "is-leaving",
    entering && "is-entering",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {index > 0 && <div className={leaving ? "layer-tint is-leaving" : "layer-tint"} />}
      <div className={cls} data-level={index}>
        <ReactFlowProvider>
          <FlowCanvas
            canvasId={canvasId}
            level={index}
            active={active && !leaving}
            parentCanvasId={parentCanvasId}
            coveredNodeId={coveredNodeId}
          />
          <CameraFocus canvasId={canvasId} active={active && !leaving} />
        </ReactFlowProvider>
      </div>
    </>
  );
});
