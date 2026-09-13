"use client";

import type { ReactNode } from "react";

/**
 * `.seg` (crm-core.css:58-60): the pill-shaped segmented control. Controlled
 * and hook-free — `aria-pressed` marks the active option, exactly as in the
 * prototype's `<div class="seg"><button aria-pressed>…`.
 */
export interface SegOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** A count rendered as a `.badge` after the label. */
  badge?: number;
  disabled?: boolean;
}

export interface SegProps<V extends string = string> {
  options: readonly SegOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** The group's accessible name ("Centre"). */
  label: string;
  className?: string;
  testId?: string;
}

export function Seg<V extends string = string>({
  options,
  value,
  onChange,
  label,
  className,
  testId,
}: SegProps<V>) {
  return (
    <div
      className={["seg", className ?? ""].filter(Boolean).join(" ")}
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
          {o.badge !== undefined ? (
            <span className="badge" style={{ marginLeft: 4 }}>
              {o.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
