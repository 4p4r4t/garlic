import { useEffect, useRef, useState, type RefObject } from "react";
import { Ban, FolderOpen } from "lucide-react";

import { api, type TaskStatus, type VaultInfo } from "../api";
import { StatusIcon, STATUS_META } from "../canvas/NodeParts";
import { PALETTE } from "../canvas/palette";
import { useGraph, useStatusColors } from "../store/graph";
import { useMode } from "../store/mode";

interface Props {
  /** Кнопка-шестерёнка: клик по ней не считается «кликом мимо». */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];

/**
 * Панель настроек (ТЗ §4.6.2): цвета статусов (палитра или «нет»), показ
 * вложенных уровней, папка базы знаний (ТЗ §4.10). Всё сохраняется в app_state
 * и применяется сразу.
 * Закрывается по Esc / клику мимо.
 */
export function SettingsPanel({ anchor, onClose }: Props) {
  const colors = useStatusColors();
  const setStatusColor = useGraph((s) => s.setStatusColor);
  const showNested = useGraph((s) => s.showNested);
  const setShowNested = useGraph((s) => s.setShowNested);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    // Без закрытия по blur: системный диалог выбора папки уводит фокус из окна.
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, onClose]);

  return (
    <div ref={ref} className="settings-panel" role="dialog" aria-label="Настройки">
      <div className="st-title">Цвет задачи по статусу</div>
      {STATUSES.map((st) => {
        const current = colors[st];
        return (
          <div key={st} className={`st-row status-${st}`}>
            <span className="st-status">
              <StatusIcon status={st} />
              <span>{STATUS_META[st].label}</span>
            </span>
            <div className="st-swatches" role="radiogroup" aria-label={STATUS_META[st].label}>
              <button
                type="button"
                role="radio"
                aria-checked={current == null}
                className={`swatch swatch-reset${current == null ? " is-active" : ""}`}
                title="Нет — ручной цвет ноды или стандартный фон"
                onClick={() => void setStatusColor(st, null)}
              >
                <Ban size={13} strokeWidth={2} />
              </button>
              {Object.entries(PALETTE).map(([key, hex]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={current === key}
                  className={`swatch${current === key ? " is-active" : ""}`}
                  style={{ background: hex }}
                  title={key}
                  onClick={() => void setStatusColor(st, key)}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="st-hint">Цвет статуса важнее ручного цвета ноды.</div>
      <div className="st-divider" />
      <label className="st-check">
        <input
          type="checkbox"
          checked={showNested}
          onChange={(e) => void setShowNested(e.target.checked)}
        />
        <span>Показывать вложенные уровни</span>
      </label>
      <div className="st-divider" />
      <VaultSetting />
    </div>
  );
}

/** Папка базы знаний: путь + «Изменить…» (системный выбор папки). */
function VaultSetting() {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const showError = useGraph((s) => s.showError);
  const bumpVault = useMode((s) => s.bumpVault);

  useEffect(() => {
    let alive = true;
    api
      .vaultInfo()
      .then((i) => alive && setInfo(i))
      .catch(showError);
    return () => {
      alive = false;
    };
  }, [showError]);

  const pick = async () => {
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        directory: true,
        multiple: false,
        defaultPath: info?.root,
        title: "Папка базы знаний",
      });
      if (typeof dir === "string" && dir && dir !== info?.root) {
        setInfo(await api.vaultSetPath(dir));
        bumpVault();
      }
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-vault">
      <div className="st-title">База знаний</div>
      <div className={info && !info.ok ? "st-vault-path is-error" : "st-vault-path"} title={info?.root}>
        {info?.root ?? "…"}
      </div>
      {info?.error && <div className="st-hint is-error">{info.error}</div>}
      <button type="button" className="st-btn" disabled={busy} onClick={() => void pick()}>
        <FolderOpen size={13} />
        <span>Изменить папку…</span>
      </button>
      <div className="st-hint">Обычные .md-файлы; можно выбрать существующий vault Obsidian.</div>
    </div>
  );
}
