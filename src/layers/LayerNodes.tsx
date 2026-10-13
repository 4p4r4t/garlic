// Особые ноды стека слоёв: нода-родитель поверх тинта (anchor, ТЗ §4.5) и
// просвечивающая нода вложенного уровня (ghost, ТЗ §4.5.1).

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { CornerLeftUp, StickyNote, Unlink } from "lucide-react";

import type { NodeModel, TaskStatus } from "../api";
import type { FlowNode, Progress } from "../canvas/flow";
import { NodeHandles } from "../canvas/NodeHandles";
import { COMMENT_LINK, NOTE_FILE, RESULT_LINK } from "../canvas/kbLink";
import { KbLinkField } from "../canvas/KbLinkField";
import { PlainTitle, ProgressBadge, StatusIcon, STATUS_META } from "../canvas/NodeParts";
import { fillStyle, nodeFillColor } from "../canvas/palette";
import { useStatusColors } from "../store/graph";
import { useKbStat } from "../store/kbLinks";

/**
 * Нода-родитель открытого слоя: выглядит ровно как на своём холсте и лежит на
 * том же месте, но поверх тинта. Не редактируется и не двигается (это нода
 * нижнего уровня); клик — выход из слоя; хэндлы работают как начало стрелки
 * «родитель → подзадача». Бейдж прогресса — живой, из задач слоя.
 */
function AnchorNodeImpl({ data }: NodeProps<FlowNode>) {
  const m = data.model;
  const status = m.status ?? "todo";
  const fill = nodeFillColor(m, useStatusColors());
  return (
    <div
      className={`g-node g-task status-${status} is-anchor${fill ? " is-filled" : ""}`}
      style={fillStyle(fill)}
      title="Клик — выйти из слоя"
    >
      <NodeHandles />
      <PlainTitle model={m} placeholder="Без названия" />
      <TaskLinks model={m} />
      <TaskFoot status={status} progress={data.progress} />
    </div>
  );
}

/**
 * Просвечивающая нода: только визуал; хэндлы невидимые и неподключаемые (на
 * них крепятся стрелки уровня). Прозрачность — по глубине (CSS).
 */
function GhostNodeImpl({ data }: NodeProps<FlowNode>) {
  const m = data.model;
  const depth = Math.min(data.depth ?? 1, 3);
  const color = nodeFillColor(m, useStatusColors());
  const fill = fillStyle(color);
  const text = useKbStat(m.kind === "note" ? m.kbPath : null)?.preview;
  if (m.kind === "note") {
    return (
      <div className={`g-node g-note is-ghost ghost-d${depth}${color ? " is-filled" : ""}`} style={fill}>
        <NodeHandles inert />
        <div className="note-head">
          <StickyNote className="note-icon" size={14} strokeWidth={2} />
          <PlainTitle model={m} placeholder="Заметка" />
        </div>
        <KbLinkField slot={NOTE_FILE} path={m.kbPath} title={m.title} />
        {text && <div className="note-preview">{text}</div>}
      </div>
    );
  }
  const status = m.status ?? "todo";
  return (
    <div
      className={`g-node g-task status-${status} is-ghost ghost-d${depth}${color ? " is-filled" : ""}`}
      style={fill}
    >
      <NodeHandles inert />
      <PlainTitle model={m} placeholder="Без названия" />
      <TaskLinks model={m} />
      <TaskFoot status={status} progress={data.progress} />
    </div>
  );
}

/**
 * Сосед по уровню (ТЗ §4.12.4): нода другого холста той же глубины поверх
 * тинта, приглушённая, с подписью родителя. Не редактируется; клик — переход.
 */
function NeighborNodeImpl({ data }: NodeProps<FlowNode>) {
  const m = data.model;
  const color = nodeFillColor(m, useStatusColors());
  const fill = fillStyle(color);
  const text = useKbStat(m.kind === "note" ? m.kbPath : null)?.preview;
  const parent = data.parentTitle == null ? "без родителя" : data.parentTitle || "Без названия";
  const caption = (
    <div className={data.parentTitle == null ? "nb-caption is-orphan" : "nb-caption"} title={parent}>
      <CornerLeftUp size={11} strokeWidth={2} />
      <span>{parent}</span>
    </div>
  );
  if (m.kind === "note") {
    return (
      <div className={`g-node g-note is-neighbor${color ? " is-filled" : ""}`} style={fill}>
        {caption}
        <NodeHandles inert />
        <div className="note-head">
          <StickyNote className="note-icon" size={14} strokeWidth={2} />
          <PlainTitle model={m} placeholder="Заметка" />
        </div>
        <KbLinkField slot={NOTE_FILE} path={m.kbPath} title={m.title} />
        {text && <div className="note-preview">{text}</div>}
      </div>
    );
  }
  const status = m.status ?? "todo";
  return (
    <div
      className={`g-node g-task status-${status} is-neighbor${color ? " is-filled" : ""}`}
      style={fill}
    >
      {caption}
      <NodeHandles inert />
      <PlainTitle model={m} placeholder="Без названия" />
      <TaskLinks model={m} />
      <TaskFoot status={status} progress={data.progress} />
    </div>
  );
}

/** Пунктирная рамка просвечивающего ничейного слоя (ТЗ §4.12.3); клик — провалиться в него. */
function OrphanFrameNodeImpl({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className="orphan-frame"
      style={{ width: data.frame?.w, height: data.frame?.h }}
      title="Слой без родителя — клик, чтобы открыть"
    >
      <span className="orphan-frame-caption">без родителя</span>
    </div>
  );
}

/**
 * Заглушка вместо якоря в ничейном слое: пунктирная «Без родителя». Клик —
 * выход из слоя, ПКМ — «Перенести в задачу…» для всего слоя.
 */
function OrphanAnchorNodeImpl() {
  return (
    <div className="g-node orphan-anchor" title="Клик — выйти из слоя, ПКМ — назначить родителя">
      <Unlink size={14} strokeWidth={2} />
      <span>Без родителя</span>
    </div>
  );
}

/** «Комментарий» и «Результат» задачи — только картинка (как в TaskNode). */
function TaskLinks({ model: m }: { model: NodeModel }) {
  return (
    <div className="task-links">
      <KbLinkField slot={COMMENT_LINK} path={m.kbPath} title={m.title} />
      <KbLinkField slot={RESULT_LINK} path={m.kbResultPath} title={m.title} />
    </div>
  );
}

/** Низ карточки задачи без интерактива: маркер и подпись статуса, бейдж (как в TaskNode). */
function TaskFoot({ status, progress }: { status: TaskStatus; progress: Progress | undefined }) {
  return (
    <div className="node-foot">
      <span className="status-marker">
        <StatusIcon status={status} />
      </span>
      <span className="status-label">{STATUS_META[status].label}</span>
      <ProgressBadge progress={progress} />
    </div>
  );
}

export const AnchorNode = memo(AnchorNodeImpl);
export const GhostNode = memo(GhostNodeImpl);
export const NeighborNode = memo(NeighborNodeImpl);
export const OrphanFrameNode = memo(OrphanFrameNodeImpl);
export const OrphanAnchorNode = memo(OrphanAnchorNodeImpl);
