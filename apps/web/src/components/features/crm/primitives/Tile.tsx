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
}: TileProps) {
  return (
    <div className={["tile", className ?? ""].filter(Boolean).join(" ")}>
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
    </div>
  );
}
