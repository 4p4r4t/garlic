// Поле-ссылка под заголовком ноды (ТЗ §4.10): пусто → «+ база знаний» и меню
// создания/привязки; заполнено → иконка + имя, клик открывает в «Базе»,
// ПКМ — «Отвязать / Привязать другое… / Создать папку / Показать в проводнике»;
// путь пропал → красное «не найдено». Без `onSet` — только картинка (якорь
// слоя, просвечивающие ноды): те же размеры, без событий.

import { memo, useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  CircleAlert,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Link2Off,
  Replace,
} from "lucide-react";

import { useKbStat } from "../store/kbLinks";
import {
  convertNoteToFolder,
  createAndLink,
  isNotePath,
  linkName,
  linkPathLabel,
  openLink,
  revealLinkInOs,
  type LinkSetter,
  type LinkSlot,
} from "./kbLink";
import { KbPicker } from "./KbPicker";
import { PopupMenu, type PopupEntry } from "./PopupMenu";

interface Props {
  slot: LinkSlot;
  /** Текущая ссылка (путь в vault) или null. */
  path: string | null;
  /** Заголовок ноды — имя по умолчанию для создаваемого. */
  title: string;
  /** Запись ссылки; нет — поле только для чтения. */
  onSet?: LinkSetter;
}

const ICON = 13;

function KbLinkFieldImpl({ slot, path, title, onSet }: Props) {
  const stat = useKbStat(path);
  const [menu, setMenu] = useState<{ x: number; y: number; items: PopupEntry[] } | null>(null);
  const [picker, setPicker] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closePicker = useCallback(() => setPicker(false), []);

  const isDir = path ? (stat?.isDir ?? !isNotePath(path)) : false;
  const broken = !!path && stat !== undefined && !stat.exists;
  const state = !path ? "is-empty" : broken ? "is-broken" : isDir ? "is-folder" : "is-note";
  const shown = path ? (slot.showPath ? linkPathLabel(path) : linkName(path)) : slot.placeholder;
  const Icon = !path ? null : broken ? CircleAlert : isDir ? Folder : FileText;
  const tip = !onSet
    ? path ?? undefined
    : !path
      ? "Привязать заметку или папку базы знаний"
      : broken
        ? `${path} — не найдено`
        : `${path}\nКлик — открыть в «Базе», ПКМ — действия`;

  const items = (): PopupEntry[] => {
    if (!onSet) return [];
    const relink: PopupEntry = {
      label: path ? "Привязать другое…" : "Привязать существующее…",
      icon: path ? <Replace size={14} /> : <Link2 size={14} />,
      onClick: () => setPicker(true),
    };
    const unlink: PopupEntry = {
      label: "Отвязать",
      icon: <Link2Off size={14} />,
      danger: true,
      onClick: () => void onSet(null),
    };
    if (!path) {
      return [
        {
          label: "Создать заметку",
          icon: <FilePlus2 size={14} />,
          onClick: () => void createAndLink(slot, "note", title, onSet),
        },
        ...(slot.allowFolders
          ? [
              {
                label: "Создать папку",
                icon: <FolderPlus size={14} />,
                onClick: () => void createAndLink(slot, "folder", title, onSet),
              },
            ]
          : []),
        "sep",
        relink,
      ];
    }
    if (broken) return [relink, unlink];
    return [
      {
        label: isDir ? "Показать в «Базе»" : "Открыть в «Базе»",
        icon: <FolderOpen size={14} />,
        onClick: () => openLink(path, isDir),
      },
      "sep",
      relink,
      ...(!isDir && slot.allowFolders
        ? [
            {
              label: "Создать папку",
              icon: <FolderPlus size={14} />,
              onClick: () => void convertNoteToFolder(path, title, onSet),
            },
          ]
        : []),
      {
        label: "Показать в проводнике",
        icon: <ExternalLink size={14} />,
        onClick: () => void revealLinkInOs(path),
      },
      "sep",
      unlink,
    ];
  };

  const openMenuAt = (x: number, y: number) => setMenu({ x, y, items: items() });

  const onClick = (e: ReactMouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (!onSet) return;
    if (path && !broken) {
      openLink(path, isDir);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 4);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onSet) openMenuAt(e.clientX, e.clientY);
  };

  const cls = `kb-link ${state}${slot.showPath ? " is-path" : ""}${onSet ? "" : " is-readonly"}`;
  const body = (
    <>
      {Icon && <Icon size={ICON} strokeWidth={2} className="kb-link-icon" />}
      <span className="kb-link-text">{shown}</span>
      {broken && <span className="kb-link-missing">не найдено</span>}
    </>
  );

  return (
    <div className="kb-link-row">
      {slot.label && (
        <div className="kb-link-label">
          {slot.icon && <slot.icon size={11} strokeWidth={2} />}
          <span>{slot.label}</span>
        </div>
      )}
      {onSet ? (
        <button
          type="button"
          className={`${cls} nodrag nopan`}
          title={tip}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {body}
        </button>
      ) : (
        <div className={cls} title={tip}>
          {body}
        </div>
      )}
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {picker && onSet && (
        <KbPicker
          title={slot.allowFolders ? "Привязать заметку или папку" : "Привязать заметку"}
          filter={slot.allowFolders ? "any" : "notes"}
          current={path}
          onPick={(p) => void onSet(p)}
          onClose={closePicker}
        />
      )}
    </div>
  );
}

export const KbLinkField = memo(KbLinkFieldImpl);
