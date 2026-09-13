/**
 * `spark()` from crm-shared.js:369 — the 72×22 trend line on a tile and on an
 * accountability card. HOOK-FREE so it can be called as a function in a
 * structure test (§3.10 "components: structure-level only").
 *
 * It is DECORATION beside a number that is already on screen, so it carries
 * `aria-hidden` and the tile's own value does the talking. A sparkline with no
 * axis is not something a screen reader can usefully announce.
 */

import { sparkGeometry } from "./model";

export interface SparkProps {
  values: readonly number[];
  /** "l1" | "l2" | "l3" | "l4" — the series stroke class. */
  tone?: "l1" | "l2" | "l3" | "l4";
}

export function Spark({ values, tone = "l1" }: SparkProps) {
  const geo = sparkGeometry(values);
  if (!geo) return null;
  const fill = tone.replace("l", "f");
  return (
    <svg
      className="spark chart"
      viewBox={`0 0 ${geo.w} ${geo.h}`}
      aria-hidden="true"
      focusable="false"
    >
      <path d={geo.path} className={tone} fill="none" strokeWidth={1.8} />
      <circle cx={geo.lastX} cy={geo.lastY} r={2.5} className={fill} />
    </svg>
  );
}
