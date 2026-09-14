import { CENTRE_LIST } from "~/features/crm/core/centres";
import {
  CONTRACT_STATUS_FILTERS,
  CONTRACT_WINDOWS,
  type ContractRow,
  type ContractStatusFilter,
  type ContractWindow,
} from "~/features/crm/contracts/contracts";
import { fDate, fDateY } from "~/features/crm/core/dates";
import { money, moneyK } from "~/features/crm/core/format";
import { GF_STATUS_META, type GfStatus } from "~/features/crm/core/types";
import { MON } from "../primitives/DateBlock";

/**
 * Pure helpers behind the Contracts screen — the part a test can hold. Copy
 * comes from the prototype (`crm-events.js:206-234`) and is used verbatim.
 *
 * NO REACT, NO SERVER: this file is imported by the screen and by
 * `model.test.ts`, and it must never reach for the sub's server barrel (that
 * drags Neon and Square into the browser bundle; §5.7b).
 */

export const WINDOW_OPTIONS = CONTRACT_WINDOWS.map(([value, label]) => ({ value, label }));

export function statusFolderOptions(): { value: ContractStatusFilter; label: string }[] {
  return CONTRACT_STATUS_FILTERS.map((value) => ({
    value,
    label: value === "all" ? "Any status" : GF_STATUS_META[value as GfStatus].label,
  }));
}

export const CENTRE_OPTIONS = CENTRE_LIST.map((c) => ({ value: c.code, label: c.short }));

/** "Week of Sep 14 – Sep 20" (crm-events.js:212), from a YYYY-MM-DD. */
export function weekLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return "";
  // Calendar arithmetic on the parts — never an instant, so no timezone can
  // slide the row into the previous week (R10).
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `Week of ${MON[start.getMonth()]} ${start.getDate()} – ${MON[end.getMonth()]} ${end.getDate()}`;
}

/**
 * Week headers are suppressed in the "Needs attention" window, exactly as the
 * prototype does (`wk !== lastWeek && win !== "attention"`): that view is a
 * work queue, not a calendar, and banding it by week hides the ordering.
 */
export function withWeekHeaders(
  rows: readonly ContractRow[],
  win: ContractWindow,
): { row: ContractRow; weekHeader: string | null }[] {
  let last: string | null = null;
  return rows.map((row) => {
    if (win === "attention") return { row, weekHeader: null };
    const wk = weekLabel(row.eventDate);
    const header = wk !== last ? wk : null;
    last = wk;
    return { row, weekHeader: header };
  });
}

/** The deposit cell: post-paid events owe none, so they show a dash, not $0. */
export function depositCell(row: ContractRow): { text: string; paid: boolean } {
  if (row.postPaid) return { text: "—", paid: false };
  return {
    text: money(row.depositDueCents) + (row.depositPaidAt ? " ✓" : ""),
    paid: Boolean(row.depositPaidAt),
  };
}

/** "HP Fort Myers · #H2879 · 42 guests" — the row's second line. */
/**
 * `rowMeta` with the event DATE in front of it.
 *
 * Owner, 2026-09-14: "Contracts page needs event date". The row already
 * carried one as a `DateBlock` stamp, which reads well across a full-width
 * table and is the first thing to go when the row narrows — and "SEP 16" on
 * its own does not say which year a 2025 contract belongs to. Spelling it out
 * in the meta line means the day survives every width.
 *
 * `rowMeta` itself is untouched: the Events board and the deal drawer both use
 * it, and neither wants a date repeated beside a date.
 */
export function contractRowMeta(row: ContractRow): string {
  const rest = rowMeta(row);
  return rest ? `${fDateY(row.eventDate)} · ${rest}` : fDateY(row.eventDate);
}

export function rowMeta(row: ContractRow): string {
  const parts: string[] = [];
  const centre = CENTRE_LIST.find((c) => c.code === row.centre);
  if (centre) parts.push(centre.short);
  else if (row.centerName) parts.push(row.centerName);
  if (row.eventNumber) parts.push(`#${row.eventNumber}`);
  if (row.guests !== null) parts.push(`${row.guests} guests`);
  return parts.join(" · ");
}

/**
 * What the row's Event control says — the tooltip AND its accessible name,
 * because the button itself is an icon and the word "Event".
 *
 * It names the DAY, because that is what the control opens: the Events board
 * for the centre and date this contract is for. A row the database cannot place
 * gets the reason instead, and the control is disabled — never a link that
 * lands on an arbitrary day and looks like the board lost the booking.
 */
export function eventJumpTitle(row: ContractRow): string {
  if (!row.centre) {
    return `No centre recorded on this contract (${row.centerCode || "unknown"}) — open it to see the event`;
  }
  const centre = CENTRE_LIST.find((c) => c.code === row.centre);
  const where = centre ? centre.short : row.centerName;
  return `Open the Events board for ${where} on ${fDate(row.eventDate)}`;
}

/** The empty-state line, per window (crm-events.js:232). */
export function emptyMessage(win: ContractWindow): string {
  return win === "attention" ? "Nothing needs a human right now." : "No contracts in this window.";
}

/** "12 contracts · sorted by event date · 25 per page" (crm-events.js:233). */
export function pagerSummary(total: number, perPage: number): string {
  return `${total} contract${total === 1 ? "" : "s"} · sorted by event date · ${perPage} per page`;
}

export interface TileSpec {
  key: "attention" | "outUnsigned" | "deposits" | "balance";
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}

/** The four tiles, verbatim from `crm-events.js:236`. */
export function tileSpecs(counts: {
  attention: number;
  outUnsigned: number;
  outUnsignedCents: number;
  depositsHeldCents: number;
  balanceOutstandingCents: number;
}): TileSpec[] {
  return [
    {
      key: "attention",
      label: "Needs attention",
      value: String(counts.attention),
      sub: "unsigned, approvals, failed charges, open past events",
    },
    {
      key: "outUnsigned",
      label: "Out, unsigned",
      value: String(counts.outUnsigned),
      unit: moneyK(counts.outUnsignedCents),
    },
    {
      key: "deposits",
      label: "Deposits held (open events)",
      value: money(counts.depositsHeldCents),
    },
    {
      key: "balance",
      label: "Balance outstanding",
      value: money(counts.balanceOutstandingCents),
      sub: "auto-charges at T-72h",
    },
  ];
}

/** The "Sent … · opened N× · not signed" banner text (crm-events.js:88). */
export function sentBannerText(row: ContractRow, pageViews: number): string {
  // `sentAgoDays` is dated on the SERVER beside `daysOut`. A `Date.now()` here
  // would be an impure call in a render body, and the banner could then
  // disagree with the attention pills sitting next to it.
  const days = row.sentAgoDays ?? 0;
  const ago = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return `Sent ${ago} · guest opened it ${pageViews}× · not signed. Automatic 96-hour reminder is scheduled.`;
}

/** The Balance tile's sub line on the Contract tab (crm-events.js:87). */
export function balanceNote(row: ContractRow): string {
  if (!row.balanceCents) return "settled";
  return row.postPaid ? "invoiced after the event" : "auto-charges 72 h before";
}

/** The Deposit tile's sub line on the Contract tab (crm-events.js:87). */
export function depositNote(row: ContractRow): string {
  if (row.depositPaidAt) return `paid ${fDate(row.depositPaidAt)}`;
  return row.postPaid ? "none — post-paid" : "due at signing";
}

// ---------------------------------------------------------------------------
// "What the guest sees" — the notes block
// ---------------------------------------------------------------------------

/** What `?notes=1` answers; declared here so the helper stays pure and testable. */
export interface LiveNotes {
  live: string | null;
  stored: string | null;
  drifted: boolean;
  error: string | null;
}

export interface NotesView {
  /** The text to render. */
  body: string;
  /** The caption under it — it must always say WHICH text this is. */
  caption: string;
  /** True when BMI and the guest's page disagree; the caption says so louder. */
  warn: boolean;
}

const NO_NOTES = "No notes on this event yet.";

/**
 * Pick the text the preview shows and the caption that tells the truth about
 * it. Three cases, and the caption differs in every one:
 *
 *  - live read OK, in step   → BMI's text, "live from BMI public notes".
 *  - live read OK, DRIFTED   → BMI's text, plus a warning that the guest's page
 *                              is still serving the older copy until
 *                              `group-quote-dispatch` picks the edit up.
 *  - live read failed / not  → the stored copy, SAID to be the stored copy.
 *    loaded yet
 *
 * The third case is the one that matters: the prototype's caption reads "Live
 * from BMI public notes", and printing a stale note under that caption is
 * exactly the failure this preview exists to catch.
 */
export function notesText(stored: string | null, notes: LiveNotes | undefined): NotesView {
  if (notes && notes.error === null && notes.live !== null) {
    return {
      body: notes.live.trim() || NO_NOTES,
      caption: notes.drifted
        ? "Live from BMI public notes — the guest's page is still showing the previous text; it catches up within a few minutes of the next sync."
        : "Live from BMI public notes · grammar lightly cleaned by AI before the guest sees it",
      warn: notes.drifted,
    };
  }
  const why = notes?.error ? "BMI could not be reached" : "not read from BMI yet";
  return {
    body: (notes?.stored ?? stored)?.trim() || NO_NOTES,
    caption: `The copy the guest's page is serving (${why}) · grammar lightly cleaned by AI before the guest sees it`,
    warn: false,
  };
}
