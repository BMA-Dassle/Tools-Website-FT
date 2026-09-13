/**
 * The Accountability screen's pure half. No React, no fetch.
 *
 * The judgement calls — when a meter turns amber, which rep the banner names,
 * how a response time reads against its target — are the only things on this
 * screen that can be WRONG rather than merely ugly, so they live here where a
 * test can hold them still.
 */

import type { MeterTone } from "../primitives/Meter";
import type { RepAccountability, WeeklyActual, WeeklyTarget } from "~/features/crm/kpi/contracts";

/** `round(a / b × 100)`, 0 with no denominator. */
export function pctOf(a: number, b: number): number {
  if (!b) return 0;
  return Math.round((a / b) * 100);
}

/**
 * The prototype's four bands (crm-shared.js:412): at or above target is green,
 * 70+ is neutral, 40+ amber, below that red.
 *
 * NEUTRAL, not green, in the 70s: a bar that turns green at three-quarters of
 * the week's work teaches a rep that three-quarters is the target.
 */
export function meterTone(pct: number): MeterTone {
  if (pct >= 100) return "good";
  if (pct >= 70) return "";
  if (pct >= 40) return "warn";
  return "crit";
}

export type ChannelKey = "calls" | "texts" | "emails" | "reachouts";

export interface ChannelRow {
  key: ChannelKey;
  label: string;
  actual: number;
  target: number;
  pct: number;
  tone: MeterTone;
}

export const CHANNELS: readonly { key: ChannelKey; label: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "texts", label: "Texts" },
  { key: "emails", label: "Emails" },
  { key: "reachouts", label: "LY reach-outs" },
];

export function channelRows(target: WeeklyTarget, actual: WeeklyActual): ChannelRow[] {
  return CHANNELS.map(({ key, label }) => {
    const pct = pctOf(actual[key], target[key]);
    return { key, label, actual: actual[key], target: target[key], pct, tone: meterTone(pct) };
  });
}

/** "38 min" · "2 h 10 m" · "—" when nobody has been answered yet. */
export function responseLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}

/** True when the median is worse than the target — the figure turns red. */
export function responseMissed(minutes: number | null, targetMinutes: number): boolean {
  return minutes !== null && minutes > targetMinutes;
}

/**
 * The director's banner sentence, built from the server's `behind` row — the
 * prototype's "Lori is at 45% of calls and 27% of last-year reach-outs with one
 * working day left. Median response 71 min (target 60)."
 *
 * The median clause is dropped when the rep is INSIDE their response target:
 * naming a number somebody is hitting, in a banner about falling behind, reads
 * as a criticism of the one thing they got right.
 */
export function behindSentence(
  behind: {
    displayName: string;
    callsPct: number;
    reachoutsPct: number;
    medianResponseMinutes: number | null;
    responseTargetMinutes: number;
  },
  workingDaysLeft: number,
): string {
  const days =
    workingDaysLeft === 0
      ? "and the week is over"
      : `with ${workingDaysLeft} day${workingDaysLeft === 1 ? "" : "s"} left`;
  const head = `${behind.displayName} is at ${behind.callsPct}% of calls and ${behind.reachoutsPct}% of last-year reach-outs ${days}.`;
  if (!responseMissed(behind.medianResponseMinutes, behind.responseTargetMinutes)) return head;
  return `${head} Median response ${responseLabel(behind.medianResponseMinutes)} (target ${behind.responseTargetMinutes} min).`;
}

/** Sum of a channel across the roster — the team table's foot. */
export function teamTotal(
  reps: readonly RepAccountability[],
  key: ChannelKey,
): {
  actual: number;
  target: number;
} {
  return reps.reduce(
    (a, r) => ({ actual: a.actual + r.actual[key], target: a.target + r.target[key] }),
    { actual: 0, target: 0 },
  );
}

/**
 * The colour a team-table cell takes (the prototype's inline style): at or
 * above target reads good, under half reads critical, anything between is
 * ordinary text rather than a third colour nobody can rank.
 */
export function cellTone(actual: number, target: number): "good" | "crit" | "" {
  if (!target) return "";
  if (actual >= target) return "good";
  if (actual / target < 0.5) return "crit";
  return "";
}
