import type { ReactNode } from "react";
import { Meter, type MeterTone } from "./Meter";

/**
 * `tile({...})` from crm-shared.js:371 — the stat tile: optional icon square,
 * label, value (+ unit), an optional meter, a delta line and a sub line.
 * Sparklines and donuts are the KPI PR's (they draw SVG); this ships the slots
 * the prototype's tile has for everything else.
 */
export interface TileProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  /** A ready-made `.delta …` node. */
  delta?: ReactNode;
  /** A tabler icon element; wrapped in the `.tico` square. */
  ico?: ReactNode;
  /** "" | "warn" | "good" | "violet" | "orange" — the `.tico` hue. */
  icoCls?: string;
  meter?: { p: number; tone?: MeterTone };
  /** Rendered top-right (e.g. a Chip). */
  corner?: ReactNode;
  className?: string;
  /**
   * Makes the whole tile a button. Owner, 2026-09-13: "on my day why can't I
   * click contracts out and other tiles". A tile states a number a planner then
   * wants to see the rows behind — Contracts out should land on Contracts,
   * Overdue on the overdue list. A figure you cannot follow is a dead end.
   *
   * Rendered as a real <button> rather than a div with a handler, so it is
   * reachable by keyboard and announced as actionable.
   */
  onClick?: () => void;
  /** Tooltip and accessible name for the click, e.g. "Open contracts out". */
  actionLabel?: string;
}

export function Tile({
  label,
  value,
  unit,
  sub,
  delta,
  ico,
  icoCls = "",
  meter,
  corner,
  className,
  onClick,
  actionLabel,
}: TileProps) {
  const cls = ["tile", onClick ? "tile-click" : "", className ?? ""].filter(Boolean).join(" ");
  const inner = (
    <>
      {ico ? <span className={["tico", icoCls].filter(Boolean).join(" ")}>{ico}</span> : null}
      {corner ? <span className="corner">{corner}</span> : null}
      <span className="label">{label}</span>
      <span className="value">
        {value}
        {unit !== undefined && unit !== null ? <small>{unit}</small> : null}
      </span>
      {meter ? <Meter pct={meter.p} tone={meter.tone} /> : null}
      {delta ?? null}
      {sub !== undefined && sub !== null ? <span className="xs muted">{sub}</span> : null}
    </>
  );
  if (!onClick) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      title={actionLabel}
      aria-label={actionLabel}
    >
      {inner}
    </button>
  );
}
