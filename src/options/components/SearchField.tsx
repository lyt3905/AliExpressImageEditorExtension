import { useId } from 'react';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 可见标签（读屏用 `opt-visually-hidden` 隐藏，视觉上靠占位符提示）。 */
  label: string;
  placeholder?: string;
}

export function SearchField({ value, onChange, label, placeholder }: SearchFieldProps): JSX.Element {
  const id = useId();
  return (
    <div className="opt-search">
      <label className="opt-visually-hidden" htmlFor={id}>
        {label}
      </label>
      <span className="opt-search__icon" aria-hidden="true">
        ⌕
      </span>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder ?? label}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
