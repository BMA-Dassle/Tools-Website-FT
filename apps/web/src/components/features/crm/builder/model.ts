/**
 * Pure helpers for the builder screen (C5).
 *
 * No React, no fetch, no clock it did not receive — so every sentence the rep
 * reads about a write is a unit test rather than a live probe. The screen
 * renders what these return and decides nothing itself.
 */

import { lineTotalCents, type QuoteLine, type QuoteLineStatus } from "~/features/crm/bmi/contracts";
import type { ChipKind } from "~/features/crm/core/types";

/** The quote's own total: what the CRM believes, from the rows the CRM holds. */
export function quoteTotalCents(lines: readonly QuoteLine[]): number {
  return lines.filter((l) => l.status !== "removed").reduce((sum, l) => sum + lineTotalCents(l), 0);
}

/** Lines the rep is looking at — everything except the ones they took off. */
export function liveLines(lines: readonly QuoteLine[]): QuoteLine[] {
  return lines.filter((l) => l.status !== "removed");
}

/** How many lines Office has not accepted. The Retry-all button's count. */
export function unwrittenCount(lines: readonly QuoteLine[]): number {
  return lines.filter(
    (l) => l.status === "pending" || l.status === "failed" || l.status === "paused",
  ).length;
}

export interface StatusChip {
  label: string;
  kind: ChipKind;
  title: string;
}

/**
 * What a line's state says, in words a rep can act on.
 *
 * "In BMI" is the only one that claims the write landed, and the service only
 * sets `written` after it has RE-READ the project and found the row — so the
 * chip means what it says.
 */
export function statusChip(status: QuoteLineStatus): StatusChip {
  switch (status) {
    case "written":
      return { label: "In BMI", kind: "won", title: "Office has this line; we read it back" };
    case "pending":
      return {
        label: "Not sent",
        kind: "warn",
        title: "Saved here, not yet accepted by Office — press Retry",
      };
    case "failed":
      return { label: "Refused", kind: "lost", title: "Office refused this line" };
    case "paused":
      return {
        label: "Writes paused",
        kind: "warn",
        title: "Saved here; BMI writes are paused by admin",
      };
    case "removed":
      return { label: "Removed", kind: "lost", title: "Taken off the quote" };
  }
}

/**
 * The sentence under a refused line.
 *
 * Office's own words come FIRST when it gave any — "Total persons (12) is
 * higher than the capacity (0) in HP Arena…" tells a rep exactly which heat and
 * by how much, which is worth more than any sentence we could write over it.
 */
export function lineErrorText(line: QuoteLine): string | null {
  if (line.status !== "failed") return null;
  const office = line.officePrompt?.message?.trim();
  if (office) return office;
  return line.writeError?.trim() || "Office refused this line.";
}

/** True when a director's "Force" button should appear beside a line. */
export function canForceLine(line: QuoteLine, canForce: boolean): boolean {
  return canForce && line.status === "failed" && line.officePrompt !== null;
}

/**
 * `?lanes=13–15&start=1080&section=Regular` — the contract availability's
 * "Hold these lanes in BMI" button already links with.
 *
 * Parsed leniently and NEVER trusted into a write: it seeds the picker so the
 * rep lands on the block they just chose. An unreadable parameter is simply
 * dropped — a mangled link should open an empty picker, not refuse to load.
 */
export interface HoldHint {
  lanes: number[];
  start: number | null;
  section: string | null;
}

export function parseHoldHint(query: Record<string, string>): HoldHint {
  return {
    lanes: parseLaneRange(query.lanes ?? ""),
    start: parseStartMinute(query.start),
    section: query.section?.trim() || null,
  };
}

/**
 * `"13–15"` (en dash, which is what `runLabel` emits) or `"13-15"` or `"13"`.
 * Anything else is no lanes at all.
 */
export function parseLaneRange(value: string): number[] {
  const m = /^(\d{1,3})\s*[–-]\s*(\d{1,3})$/.exec(value.trim());
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 64) return [];
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const single = /^(\d{1,3})$/.exec(value.trim());
  return single ? [Number(single[1])] : [];
}

function parseStartMinute(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 24 * 60 ? n : null;
}

/**
 * Minutes from midnight → the centre-local wall-clock stamp Office wants.
 *
 * String surgery, no `Date`: a `Date` on a UTC lambda and a `Date` on a rep's
 * laptop disagree about what 6pm is, and an evening that crosses midnight in
 * UTC is the `bookedAt` bug all over again.
 */
export function stampFor(date: string, minuteOfDay: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minuteOfDay)));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${date.slice(0, 10)}T${hh}:${mm}:00`;
}

/** `.heat.ok` / `.low` / `.full` — the prototype's own three states. */
export function heatClass(freePlaces: number, capacity: number): "ok" | "low" | "full" {
  if (freePlaces <= 0) return "full";
  return freePlaces < Math.max(1, Math.round(capacity / 2)) ? "low" : "ok";
}

/**
 * What the header says about the Office project.
 *
 * A lead with no project is the honest "nothing in BMI yet" rather than an
 * empty reference number pretending to be one.
 */
export function projectLabel(number: string | null, projectId: string | null): string {
  if (number) return number;
  if (projectId) return `Project ${projectId}`;
  return "Not in BMI yet";
}

/** "3 lines · 2 not sent" — the quote table's caption. */
export function linesCaption(lines: readonly QuoteLine[]): string {
  const live = liveLines(lines).length;
  const head = live === 1 ? "1 line" : `${live} lines`;
  const pending = unwrittenCount(lines);
  return pending > 0 ? `${head} · ${pending} not in BMI` : head;
}
