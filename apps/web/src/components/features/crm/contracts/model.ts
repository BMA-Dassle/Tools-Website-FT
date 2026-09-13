import { CENTRE_LIST } from "~/features/crm/core/centres";
import {
  CONTRACT_STATUS_FILTERS,
  CONTRACT_WINDOWS,
  type ContractRow,
  type ContractStatusFilter,
  type ContractWindow,
} from "~/features/crm/contracts/contracts";
import { fDate } from "~/features/crm/core/dates";
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
export function rowMeta(row: ContractRow): string {
  const parts: string[] = [];
  const centre = CENTRE_LIST.find((c) => c.code === row.centre);
  if (centre) parts.push(centre.short);
  else if (row.centerName) parts.push(row.centerName);
  if (row.eventNumber) parts.push(`#${row.eventNumber}`);
  if (row.guests !== null) parts.push(`${row.guests} guests`);
  return parts.join(" · ");
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
