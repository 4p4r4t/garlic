import { ChevronDown, Search, Settings } from "lucide-react";

import { useGraph } from "../store/graph";

/**
 * Тонкий топбар (ТЗ §3). Пока заглушка: имя активного пространства и крошки.
 * M3 — хлебные крошки слоёв, M4 — переключатель пространств, M6 — поиск.
 */
export function Topbar() {
  const space = useGraph((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const name = space?.name ?? "…";
  return (
    <header className="topbar">
      <button type="button" className="tb-space" disabled title="Пространства (скоро)">
        <span>{name}</span>
        <ChevronDown size={14} />
      </button>
      <nav className="tb-crumbs" aria-label="Путь">
        <span className="crumb is-current">{name}</span>
      </nav>
      <div className="tb-spacer" />
      <button type="button" className="tb-icon" disabled title="Поиск (скоро)">
        <Search size={15} />
      </button>
      <button type="button" className="tb-icon" disabled title="Настройки (скоро)">
        <Settings size={15} />
      </button>
    </header>
  );
}
