/**
 * `donut()` from crm-shared.js:370 — the goal-pace ring. Pure CSS
 * (`conic-gradient` off `--p`, crm.css `.ring.lg`), no SVG.
 *
 * The percentage is INSIDE the ring as text, so the figure is never carried by
 * the arc alone; `role="img"` + a label names it for a screen reader, which
 * would otherwise read a bare "64%" with no idea what of.
 */

export interface DonutProps {
  /** 0–100; clamped, because 140% of goal would wrap the gradient to 40%. */
  pct: number;
  label: string;
  size?: number;
}

export function Donut({ pct, label, size = 56 }: DonutProps) {
  const p = Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
  return (
    <div
      className="ring lg donut"
      style={{ ["--p" as string]: `${p}%`, width: size, height: size }}
      role="img"
      aria-label={`${label}: ${p}%`}
    >
      <span aria-hidden="true">{p}%</span>
    </div>
  );
}
