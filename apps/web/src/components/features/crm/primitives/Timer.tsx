import type { ReactNode } from "react";

/**
 * `.timer` (crm-core.css:144) — the tabular "Due in 40 min" / "waiting 1 h 12 m"
 * strip, tinted by urgency. Pure: formatting the duration is the caller's.
 */
export type TimerTone = "" | "warn" | "crit";

export interface TimerProps {
  tone?: TimerTone;
  /** A tabler icon element (clock, bolt). */
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Timer({ tone = "", icon, title, className, children }: TimerProps) {
  const cls = ["timer", tone, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} title={title}>
      {icon ?? null}
      {children}
    </span>
  );
}

/** `dur(mins)` from crm-shared.js:77 — "45 min", "3 h 05 m", "2 d 4 h". */
export function formatMinutes(mins: number): string {
  const m0 = Math.max(0, Math.round(mins));
  if (m0 < 60) return `${m0} min`;
  const h = Math.floor(m0 / 60);
  const m = m0 % 60;
  if (h < 24) return `${h} h ${String(m).padStart(2, "0")} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
