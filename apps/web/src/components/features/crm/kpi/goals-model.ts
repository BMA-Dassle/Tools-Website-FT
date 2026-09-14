/**
 * The Goals grid's pure half: what the owner typed, what changed, and what the
 * totals come to. No React — the grid's arithmetic is the part that must be
 * right, and a number that only exists inside a `useState` cannot be asserted.
 */

import type { GoalCell, GoalMirrorState } from "~/features/crm/kpi/contracts";

/** One cell of the grid: a rep and a month. */
export function cellKey(repSlug: string, month: number): string {
  return `${repSlug}:${month}`;
}

/**
 * Read a typed goal as CENTS. Whole dollars only: the field is a yearly target
 * in the tens of thousands, "$1,240.57" is a typo rather than a requirement,
 * and Pandora's own schema takes a whole-dollar number.
 *
 * Commas, spaces, a leading `$` and a trailing `k` are all things people
 * actually type into a box like this, so all four are understood rather than
 * silently producing NaN. Anything else parses to null and the cell keeps its
 * last good value instead of saving a zero nobody meant.
 */
export function parseMoneyInput(raw: string): number | null {
  const text = raw.trim().replace(/[$,\s]/g, "");
  if (text === "") return 0;
  const k = /^(\d+(?:\.\d+)?)k$/i.exec(text);
  if (k) return Math.round(Number(k[1]) * 1000) * 100;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text)) * 100;
}

/** Cents → the plain grouped dollars the input shows ("12,000"). */
export function formatMoneyInput(cents: number): string {
  if (!cents) return "";
  return Math.round(cents / 100).toLocaleString("en-US");
}

export type GoalDraft = Record<string, string>;

/** Seed the editable grid from the server's cells. */
export function draftFromCells(cells: readonly GoalCell[]): GoalDraft {
  const out: GoalDraft = {};
  for (const c of cells) out[cellKey(c.repSlug, c.month)] = formatMoneyInput(c.goalCents);
  return out;
}

export interface GoalEdit {
  repSlug: string;
  year: number;
  month: number;
  goalCents: number;
}

/**
 * Every cell whose value differs from the server's, as a save payload.
 *
 * ONLY THE CHANGED CELLS. Posting the whole grid would work — the upsert skips
 * rows whose value did not move — but it would also enqueue a Pandora mirror
 * for every salesperson every time anybody saved one number, and the Goals
 * screen would fill with mirror rows for years nobody touched.
 *
 * A cell that will not parse is DROPPED, never coerced to zero: an unreadable
 * box must not quietly wipe a target somebody set.
 */
export function dirtyCells(draft: GoalDraft, cells: readonly GoalCell[], year: number): GoalEdit[] {
  const out: GoalEdit[] = [];
  for (const c of cells) {
    const raw = draft[cellKey(c.repSlug, c.month)];
    if (raw === undefined) continue;
    const parsed = parseMoneyInput(raw);
    if (parsed === null) continue;
    if (parsed === c.goalCents) continue;
    out.push({ repSlug: c.repSlug, year, month: c.month, goalCents: parsed });
  }
  return out;
}

/** True when any cell holds something that will not parse — Save says so. */
export function invalidCells(draft: GoalDraft): string[] {
  return Object.entries(draft)
    .filter(([, v]) => parseMoneyInput(v) === null)
    .map(([k]) => k);
}

export interface MonthTotals {
  month: number;
  goalCents: number;
  lastYearCents: number;
  actualCents: number | null;
}

/** Per-month column totals across every salesperson in the grid. */
export function monthTotals(cells: readonly GoalCell[], draft: GoalDraft): MonthTotals[] {
  const by = new Map<number, MonthTotals>();
  for (const c of cells) {
    const row = by.get(c.month) ?? {
      month: c.month,
      goalCents: 0,
      lastYearCents: 0,
      actualCents: null,
    };
    const typed = parseMoneyInput(draft[cellKey(c.repSlug, c.month)] ?? "");
    row.goalCents += typed ?? c.goalCents;
    row.lastYearCents += c.lastYearCents;
    if (c.actualCents !== null) row.actualCents = (row.actualCents ?? 0) + c.actualCents;
    by.set(c.month, row);
  }
  return [...by.values()].sort((a, b) => a.month - b.month);
}

export interface YearTotals {
  goalCents: number;
  lastYearCents: number;
  /** Whole percent the goal implies over last year; null when LY was zero. */
  growthPct: number | null;
}

export function yearTotals(rows: readonly MonthTotals[]): YearTotals {
  const goalCents = rows.reduce((a, r) => a + r.goalCents, 0);
  const lastYearCents = rows.reduce((a, r) => a + r.lastYearCents, 0);
  return {
    goalCents,
    lastYearCents,
    growthPct: lastYearCents
      ? Math.round(((goalCents - lastYearCents) / lastYearCents) * 100)
      : null,
  };
}

/** Last year × the suggest factor, rounded to the nearest $100. */
export function suggestFrom(lastYearCents: number, factor: number): number {
  return Math.round((lastYearCents * factor) / 10_000) * 10_000;
}

/** Fill every cell that has a last-year figure with the suggestion. */
export function suggestAll(
  cells: readonly GoalCell[],
  factor: number,
  draft: GoalDraft,
): GoalDraft {
  const next: GoalDraft = { ...draft };
  for (const c of cells) {
    if (c.lastYearCents <= 0) continue;
    next[cellKey(c.repSlug, c.month)] = formatMoneyInput(suggestFrom(c.lastYearCents, factor));
  }
  return next;
}

/**
 * One line per rep whose Pandora mirror is not `done`, newest first — what the
 * Goals screen prints beside the year. A mirror that failed is NEVER silent:
 * Neon holds the truth, but commissions read Pandora, so a director has to be
 * told the two have drifted.
 */
export function mirrorLines(mirror: readonly GoalMirrorState[]): {
  repSlug: string;
  tone: "warn" | "crit" | "ok";
  text: string;
}[] {
  return mirror
    .filter((m) => m.status !== "done")
    .map((m) => ({
      repSlug: m.repSlug,
      tone: m.status === "parked" ? "crit" : m.status === "failed" ? "warn" : ("ok" as const),
      text:
        m.status === "parked"
          ? `${m.repSlug}: the Pandora mirror gave up after ${m.attempts} attempt${m.attempts === 1 ? "" : "s"} — ${m.lastError ?? "no reason recorded"}. Neon still holds the goal.`
          : m.status === "failed"
            ? `${m.repSlug}: the Pandora mirror failed (${m.lastError ?? "no reason recorded"}) and will be retried. Neon still holds the goal.`
            : `${m.repSlug}: the Pandora mirror is queued.`,
    }));
}
