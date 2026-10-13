import { lazy, Suspense, useEffect } from "react";

import { LayerStack } from "./layers/LayerStack";
import { TaskOverview } from "./overview/TaskOverview";
import { HotkeyHelp } from "./canvas/hotkeys";
import { GraphSearch, GraphSearchHotkey } from "./search/GraphSearch";
import { useGraph } from "./store/graph";
import { useKbLinks } from "./store/kbLinks";
import { useMode } from "./store/mode";
import { Topbar } from "./topbar/Topbar";

// Режим «База» (CodeMirror, markdown) — отдельный чанк, грузится при первом входе.
const KbMode = lazy(() => import("./kb/KbMode"));

export default function App() {
  const phase = useGraph((s) => s.phase);
  const fatal = useGraph((s) => s.fatal);
  const toast = useGraph((s) => s.toast);
  const dismissToast = useGraph((s) => s.dismissToast);
  const init = useGraph((s) => s.init);
  const mode = useMode((s) => s.mode);
  const kbMounted = useMode((s) => s.kbMounted);

  useEffect(() => {
    void init();
    void useMode.getState().init();
    void useKbLinks.getState().init();
  }, [init]);

  // Ctrl+1 / Ctrl+2 — «Граф» / «База» (ТЗ §4.10).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.code === "Digit1" || e.code === "Digit2") {
        e.preventDefault();
        useMode.getState().setMode(e.code === "Digit1" ? "graph" : "kb");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="app">
      <Topbar />
      <main className="canvas-area">
        <div className={mode === "graph" ? "graph-view" : "graph-view is-hidden"} aria-hidden={mode !== "graph"}>
          {phase === "ready" ? (
            <>
              <LayerStack />
              <TaskOverview />
            </>
          ) : phase === "error" ? (
            <div className="screen-msg is-error">Не удалось открыть данные: {fatal}</div>
          ) : (
            <div className="screen-msg">Загрузка…</div>
          )}
        </div>
        {kbMounted && (
          <div className={mode === "kb" ? "kb-host" : "kb-host is-hidden"} aria-hidden={mode !== "kb"}>
            <Suspense fallback={<div className="screen-msg">Загрузка базы знаний…</div>}>
              <KbMode active={mode === "kb"} />
            </Suspense>
          </div>
        )}
      </main>
      <HotkeyHelp />
      <GraphSearch />
      <GraphSearchHotkey />
      {toast && (
        <div className="toast" role="alert" onClick={dismissToast}>
          {toast}
        </div>
      )}
    </div>
  );
}
