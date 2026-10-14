import { memo, useCallback } from "react";
import type { NodeProps } from "@xyflow/react";

import { NEXT_STATUS, useGraph, useStatusColors } from "../store/graph";
import type { FlowNode } from "./flow";
import { COMMENT_LINK, RESULT_LINK } from "./kbLink";
import { KbLinkField } from "./KbLinkField";
import { NodeHandles } from "./NodeHandles";
import { ProgressBadge, StatusIcon, StickerCard, STATUS_META } from "./NodeParts";
import { NodeTitle } from "./NodeTitle";
import { fillStyle, nodeFillColor } from "./palette";

function TaskNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const m = data.model;
  const cycleStatus = useGraph((s) => s.cycleStatus);
  const enterLayer = useGraph((s) => s.enterLayer);
  const status = m.status ?? "todo";
  const { label } = STATUS_META[status];
  const fill = nodeFillColor(m, useStatusColors());
  const updateNode = useGraph((s) => s.updateNode);
  const setComment = useCallback(
    (kbPath: string | null) => updateNode(m.canvasId, m.id, { kbPath }),
    [updateNode, m.canvasId, m.id],
  );
  const setResult = useCallback(
    (kbResultPath: string | null) => updateNode(m.canvasId, m.id, { kbResultPath }),
    [updateNode, m.canvasId, m.id],
  );

  const cycles = !!NEXT_STATUS[status];
  const marker = (
    <button
      type="button"
      className={`status-marker nodrag${cycles ? "" : " is-fixed"}`}
      title={cycles ? `${label} — нажмите, чтобы сменить` : `${label} — статус меняется через ПКМ`}
      aria-label={`Статус: ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        cycleStatus(m.canvasId, m.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <StatusIcon status={status} />
    </button>
  );

  // Стикер (ТЗ §4.12.7): компактная карточка у угла своей задачи.
  if (m.stickerOf) {
    return (
      <StickerCard
        model={m}
        fill={fillStyle(fill)}
        className={selected ? "is-selected" : undefined}
        title={<NodeTitle model={m} placeholder="Без названия" />}
        marker={marker}
      >
        <NodeHandles />
      </StickerCard>
    );
  }

  return (
    <div
      className={`g-node g-task status-${status}${selected ? " is-selected" : ""}${fill ? " is-filled" : ""}`}
      style={fillStyle(fill)}
    >
      <NodeHandles />
      <NodeTitle model={m} placeholder="Без названия" />
      {/* Три раздела задачи (ТЗ §4.11): название, «Комментарий», «Результат». */}
      <div className="task-links">
        <KbLinkField slot={COMMENT_LINK} path={m.kbPath} title={m.title} onSet={setComment} />
        <KbLinkField slot={RESULT_LINK} path={m.kbResultPath} title={m.title} onSet={setResult} />
      </div>
      <div className="node-foot">
        {marker}
        <span className="status-label">{label}</span>
        <ProgressBadge
          progress={data.progress}
          title="Подзадачи: выполнено / всего. Двойной клик — открыть"
          onDoubleClick={(e) => {
            e.stopPropagation();
            void enterLayer(m.id);
          }}
        />
      </div>
    </div>
  );
}

export const TaskNode = memo(TaskNodeImpl);
