import { useEffect, useRef, useState } from "react";

import { useGraph } from "../store/graph";
import type { NodeModel } from "../api";

interface Props {
  model: NodeModel;
  placeholder: string;
}

/** Заголовок ноды; в режиме редактирования — поле ввода (Enter — сохранить, Esc — отмена). */
export function NodeTitle({ model, placeholder }: Props) {
  const editing = useGraph((s) => s.editingNodeId === model.id);
  if (editing) return <TitleEditor model={model} />;
  return (
    <div className={model.title ? "node-title" : "node-title is-empty"}>
      {model.title || placeholder}
    </div>
  );
}

function TitleEditor({ model }: { model: NodeModel }) {
  const updateNode = useGraph((s) => s.updateNode);
  const stopEditing = useGraph((s) => s.stopEditing);
  const [value, setValue] = useState(model.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Только что созданная нода React Flow остаётся visibility:hidden, пока её
    // не измерят, и фокус на неё не встаёт — пробуем несколько кадров подряд.
    let raf = 0;
    let tries = 0;
    const tryFocus = () => {
      el.focus();
      if (document.activeElement === el) {
        el.select();
      } else if (++tries < 30) {
        raf = requestAnimationFrame(tryFocus);
      }
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Автовысота под многострочный заголовок.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    stopEditing();
    const title = value.trim();
    if (save && title !== model.title) {
      void updateNode(model.canvasId, model.id, { title });
    }
  };

  return (
    <textarea
      ref={ref}
      className="node-title-input nodrag nopan nowheel"
      value={value}
      rows={1}
      spellCheck={false}
      placeholder="Название"
      onChange={(e) => setValue(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
