// Переключатель области поиска при включённом фильтре «Показывать только
// результаты» (ТЗ §4.11): Ctrl+O и поиск по базе ищут по результатам задач,
// «везде» — по всей базе. Без фильтра не показывается.

import { Flag, Globe } from "lucide-react";

export function ScopeToggle({
  everywhere,
  onChange,
  hint,
}: {
  everywhere: boolean;
  onChange: (everywhere: boolean) => void;
  /** Подсказка клавиши (напр. «Tab»). */
  hint?: string;
}) {
  const tip = hint ? ` (${hint})` : "";
  return (
    <div className="kb-scope" role="radiogroup" aria-label="Где искать">
      <button
        type="button"
        role="radio"
        aria-checked={!everywhere}
        className={everywhere ? "kb-scope-btn" : "kb-scope-btn is-active"}
        title={`Искать только среди результатов задач${tip}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(false)}
      >
        <Flag size={12} />
        <span>результаты</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={everywhere}
        className={everywhere ? "kb-scope-btn is-active" : "kb-scope-btn"}
        title={`Искать по всей базе${tip}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(true)}
      >
        <Globe size={12} />
        <span>везде</span>
      </button>
    </div>
  );
}
