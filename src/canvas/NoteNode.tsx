import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";

import type { FlowNode } from "./flow";
import { NodeHandles } from "./NodeHandles";
import { NodeTitle } from "./NodeTitle";
import { fillStyle } from "./palette";

/** Превью первых строк тела заметки (редактор Markdown — M5). */
function preview(body: string): string {
  return body.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
}

function NoteNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const text = preview(m.body);
  return (
    <div
      className={`g-node g-note${selected ? " is-selected" : ""}${m.color ? " is-filled" : ""}`}
      style={fillStyle(m.color)}
    >
      <NodeHandles />
      <div className="note-head">
        <StickyNote className="note-icon" size={14} strokeWidth={2} />
        <NodeTitle model={m} placeholder="Заметка" />
      </div>
      {text && <div className="note-preview">{text}</div>}
    </div>
  );
}

export const NoteNode = memo(NoteNodeImpl);
