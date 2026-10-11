import { useEffect, useRef, useState } from "react";

interface Props {
  initial: string;
  placeholder?: string;
  className?: string;
  /** Вызывается с обрезанным непустым значением. Пустое значение = отмена. */
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** Однострочное поле редактирования на месте: Enter / потеря фокуса — сохранить, Esc — отмена. */
export function InlineInput({ initial, placeholder, className, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (save && v) onCommit(v);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className={className ? `inline-input ${className}` : "inline-input"}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // Esc не должен долетать до панели/холста: он отменяет только редактирование.
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
