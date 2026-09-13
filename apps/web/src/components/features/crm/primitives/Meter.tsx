import type { ReactNode } from "react";

/**
 * `.meter` and `.meter-row` (crm-core.css:237-241; used by every progress
 * strip in the prototype). `pct` is clamped to 0–100.
 */
export type MeterTone = "" | "good" | "warn" | "crit";

export interface MeterProps {
  pct: number;
  tone?: MeterTone;
  /** Accessible name; when given the meter becomes a progressbar. */
  label?: string;
  className?: string;
}

export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function Meter({ pct, tone = "", label, className }: MeterProps) {
  const p = clampPct(pct);
  const cls = ["meter", tone, className ?? ""].filter(Boolean).join(" ");
  const a11y = label
    ? {
        role: "progressbar",
        "aria-label": label,
        "aria-valuenow": p,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
      }
    : {};
  return (
    <div className={cls} {...a11y}>
      <i style={{ width: `${p}%` }} />
    </div>
  );
}

export interface MeterRowProps extends MeterProps {
  /** The left label ("Calls"). */
  name: ReactNode;
  /** The right number ("12 / 40"). */
  n: ReactNode;
}

export function MeterRow({ name, n, ...meter }: MeterRowProps) {
  return (
    <div className="meter-row">
      <span className="small">{name}</span>
      <Meter {...meter} />
      <span className="n">{n}</span>
    </div>
  );
}
