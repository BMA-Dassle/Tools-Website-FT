"use client";

import type { SegOption } from "./Seg";

/**
 * `.folders` (crm-core.css:172-174): the scrolling row of filter pills
 * ("All · Unread 2 · Texts · Email"). Same contract as `Seg`, different skin.
 */
export interface FoldersProps<V extends string = string> {
  options: readonly SegOption<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  className?: string;
  testId?: string;
}

export function Folders<V extends string = string>({
  options,
  value,
  onChange,
  label,
  className,
  testId,
}: FoldersProps<V>) {
  return (
    <div
      className={["folders", className ?? ""].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.badge !== undefined ? <span className="badge">{o.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
