import { memo, useCallback } from "react";
import type { NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";

import { useGraph } from "../store/graph";
import { useKbStat } from "../store/kbLinks";
import type { FlowNode } from "./flow";
import { NOTE_FILE } from "./kbLink";
import { KbLinkField } from "./KbLinkField";
import { NodeHandles } from "./NodeHandles";
import { NodeTitle } from "./NodeTitle";
import { fillStyle } from "./palette";

/**
 * Нода-заметка — карточка .md-файла базы знаний (ТЗ §4.10): заголовок = имя
 * файла, под ним — ссылка на файл, ниже — превью его первых строк.
 */
function NoteNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const updateNode = useGraph((s) => s.updateNode);
  const preview = useKbStat(m.kbPath)?.preview;
  const setLink = useCallback(
    (kbPath: string | null) => updateNode(m.canvasId, m.id, { kbPath }),
    [updateNode, m.canvasId, m.id],
  );
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
      <KbLinkField slot={NOTE_FILE} path={m.kbPath} title={m.title} onSet={setLink} />
      {preview && <div className="note-preview">{preview}</div>}
    </div>
  );
}

export const NoteNode = memo(NoteNodeImpl);
