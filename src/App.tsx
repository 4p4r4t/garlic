import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";

import { FlowCanvas } from "./canvas/Canvas";
import { useGraph } from "./store/graph";
import { Topbar } from "./topbar/Topbar";

export default function App() {
  const phase = useGraph((s) => s.phase);
  const fatal = useGraph((s) => s.fatal);
  const toast = useGraph((s) => s.toast);
  const dismissToast = useGraph((s) => s.dismissToast);
  const init = useGraph((s) => s.init);
  // Активный холст — вершина стека слоёв. M3 будет рисовать стек с тинтом.
  const activeCanvas = useGraph((s) => s.layers[s.layers.length - 1]);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="app">
      <Topbar />
      <main className="canvas-area">
        {phase === "ready" && activeCanvas ? (
          <ReactFlowProvider key={activeCanvas}>
            <FlowCanvas canvasId={activeCanvas} />
          </ReactFlowProvider>
        ) : phase === "error" ? (
          <div className="screen-msg is-error">
            Не удалось открыть данные: {fatal}
          </div>
        ) : (
          <div className="screen-msg">Загрузка…</div>
        )}
      </main>
      {toast && (
        <div className="toast" role="alert" onClick={dismissToast}>
          {toast}
        </div>
      )}
    </div>
  );
}
