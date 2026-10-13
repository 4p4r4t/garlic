import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Ban, Folder, FolderOpen, Home } from "lucide-react";

import {
  api,
  APP_STATE,
  DEFAULT_ATTACHMENTS_FOLDER,
  type LinkRole,
  type TaskStatus,
  type VaultInfo,
} from "../api";
import { KbPicker } from "../canvas/KbPicker";
import { StatusIcon, STATUS_META } from "../canvas/NodeParts";
import { PALETTE } from "../canvas/palette";
import { useGraph, useStatusColors } from "../store/graph";
import { useKbLinks } from "../store/kbLinks";
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
  const highlight = useGraph((s) => s.highlight);
  const moveWithSubtasks = useGraph((s) => s.moveWithSubtasks);
  const setMoveWithSubtasks = useGraph((s) => s.setMoveWithSubtasks);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // Окно выбора папки (портал) — часть панели.
      const inPicker = t instanceof Element && t.closest(".kbp-backdrop");
      if (!ref.current?.contains(t) && !anchor.current?.contains(t) && !inPicker) onClose();
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
          checked={showNested && !highlight}
          disabled={highlight}
          onChange={(e) => void setShowNested(e.target.checked)}
        />
        <span>
          Показывать вложенные уровни{highlight ? " (при подсветке видны все)" : ""}
        </span>
      </label>
      <label className="st-check" title="Перетаскивание задачи двигает и все её подзадачи (координаты слоёв общие)">
        <input
          type="checkbox"
          checked={moveWithSubtasks}
          onChange={(e) => void setMoveWithSubtasks(e.target.checked)}
        />
        <span>Всегда двигать задачу вместе с подзадачами</span>
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
      <DefaultFolderSetting />
      <NoteBehaviorSettings />
    </div>
  );
}

/** Обновление ссылок при переименовании и папка вложений (M6c). */
function NoteBehaviorSettings() {
  const showError = useGraph((s) => s.showError);
  const [updateLinks, setUpdateLinks] = useState(true);
  const [folder, setFolder] = useState(DEFAULT_ATTACHMENTS_FOLDER);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.getAppState(APP_STATE.kbUpdateLinks),
      api.getAppState(APP_STATE.kbAttachmentsFolder),
    ])
      .then(([links, att]) => {
        if (!alive) return;
        setUpdateLinks(links !== "0");
        if (att != null && att.trim()) setFolder(att);
      })
      .catch(showError);
    return () => {
      alive = false;
    };
  }, [showError]);

  const toggleLinks = (on: boolean) => {
    setUpdateLinks(on);
    api.setAppState(APP_STATE.kbUpdateLinks, on ? "1" : "0").catch(showError);
  };
  const commitFolder = () => {
    // Относительный путь внутри vault: без обратных слэшей, `..` и краевых `/`.
    const clean = folder
      .replace(/\\/g, "/")
      .split("/")
      .map((p) => p.trim())
      .filter((p) => p && p !== "." && p !== "..")
      .join("/");
    const value = clean || DEFAULT_ATTACHMENTS_FOLDER;
    setFolder(value);
    api.setAppState(APP_STATE.kbAttachmentsFolder, value).catch(showError);
  };

  return (
    <div className="st-folder">
      <label className="st-check">
        <input type="checkbox" checked={updateLinks} onChange={(e) => toggleLinks(e.target.checked)} />
        <span>Обновлять ссылки при переименовании</span>
      </label>
      <div className="st-hint">
        При переименовании и перемещении заметки (и картинки) в приложении ссылки на неё в других
        заметках исправляются.
      </div>
      <div className="st-folder-row">
        <div className="st-subtitle">Папка вложений</div>
        <input
          className="st-input"
          value={folder}
          spellCheck={false}
          title="Сюда сохраняются картинки, вставленные из буфера или перетащенные в заметку (создаётся при первом использовании)"
          onChange={(e) => setFolder(e.target.value)}
          onBlur={commitFolder}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
    </div>
  );
}

const FOLDER_ROWS: { role: LinkRole; label: string; hint: string; picker: string }[] = [
  {
    role: "note",
    label: "Новые заметки из графа",
    hint: "Папка, в которой создаются файлы нод-заметок",
    picker: "Папка для новых заметок",
  },
  {
    role: "comment",
    label: "«Комментарии» задач",
    hint: "Папка, в которой создаются заметки и папки поля «Комментарий» (создаётся при первом использовании)",
    picker: "Папка для комментариев",
  },
  {
    role: "result",
    label: "«Результаты» задач",
    hint: "Папка, в которой создаются заметки и папки поля «Результат» (создаётся при первом использовании)",
    picker: "Папка для результатов",
  },
];

/** Папки, в которых создаётся новое из графа: по роли ссылки (ТЗ §4.10, §4.11). */
function DefaultFolderSetting() {
  const folders = useKbLinks((s) => s.folders);
  const setFolder = useKbLinks((s) => s.setFolder);
  const [picking, setPicking] = useState<LinkRole | null>(null);
  const close = useCallback(() => setPicking(null), []);
  const row = FOLDER_ROWS.find((r) => r.role === picking);
  return (
    <div className="st-folder">
      {FOLDER_ROWS.map((r) => {
        const folder = folders[r.role];
        return (
          <div key={r.role} className="st-folder-row">
            <div className="st-subtitle">{r.label}</div>
            <button
              type="button"
              className="st-btn st-folder-btn"
              title={r.hint}
              onClick={() => setPicking(r.role)}
            >
              {folder ? <Folder size={13} /> : <Home size={13} />}
              <span>{folder || "Корень базы"}</span>
            </button>
          </div>
        );
      })}
      {row && (
        <KbPicker
          title={row.picker}
          filter="folders"
          includeRoot
          current={folders[row.role]}
          onPick={(p) => void setFolder(row.role, p)}
          onClose={close}
        />
      )}
    </div>
  );
}
