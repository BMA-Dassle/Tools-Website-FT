/**
 * "Why we lost" — the prototype's `hbars()` (crm-shared.js:370). One bar per
 * reason, longest first. Hook-free.
 *
 * MAGNITUDE, so ONE hue at one weight: these are counts of the same kind of
 * thing, and giving each reason its own colour would suggest a category system
 * that does not exist. The reason is the label; the bar is the number.
 *
 * "Not recorded" is a real row, not a gap. A pile of losses with no reason is
 * the most actionable thing this card can tell a director, and dropping it
 * would make the recorded reasons look more complete than they are.
 */

import { MEASURE_TEST_IDS, type LostRow } from "~/features/crm/kpi/contracts";

export interface LostBarsProps {
  rows: readonly LostRow[];
}

export function LostBars({ rows }: LostBarsProps) {
  if (rows.length === 0) {
    return <p className="xs muted">Nothing lost in this window.</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="hbars" data-testid={MEASURE_TEST_IDS.lost}>
      {rows.map((r) => (
        <div className="hbar" key={r.reason}>
          <span className="small">{r.reason}</span>
          <div
            className="bar"
            style={{
              width: `${Math.max(2, Math.round((r.n / max) * 100))}%`,
              background: "var(--s2)",
            }}
          />
          <span className="n">{r.n}</span>
        </div>
      ))}
    </div>
  );
}
