import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";

import type { FlowNode } from "./flow";
import { NodeHandles } from "./NodeHandles";
import { notePreview } from "./NodeParts";
import { NodeTitle } from "./NodeTitle";
import { fillStyle } from "./palette";

function NoteNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const text = notePreview(m.body);
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
