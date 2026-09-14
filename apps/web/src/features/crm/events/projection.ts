/**
 * THE BOARD MERGE — pure, and therefore the thing the tests can pin.
 *
 * BMI is the truth about what is happening on a day (`listDailyEvents`); the
 * contract row adds what the guest has paid (`group_function_quotes`); the CRM
 * lead adds who owns it. Nothing here touches Neon, Office or Redis — the
 * service hands the three lists in and this file decides what a row says.
 *
 * The pill ladder is `crm-events.js:246`, in its order and with its words:
 * settled → PAID, signed → DEPOSIT, still out → UNSIGNED, anything else its
 * own GF chip, no contract at all → the outlined "no contract" chip.
 *
 * Client-safe: type-only imports. `EventsScreen` imports this file by path.
 */

import { shiftYmd } from "../core/dates";
import { GF_STATUS_META, type CentreCode, type GfStatus } from "../core/types";
import {
  EMPTY_FOOD_OUT,
  EVENTS_WEEK_DAYS,
  type EventContractView,
  type EventDayBand,
  type EventFoodOut,
  type EventLeadLink,
  type EventPill,
  type EventRowView,
  type EventsView,
} from "./contracts";

/** The reservation columns the board reads (structural — `daily-events` Reservation). */
export interface BoardReservation {
  id: string;
  number: string;
  name: string;
  personName: string;
  persons: number;
  when: string;
  state: string;
  stateId?: string;
  responsible: string;
  balance: number;
  registeredPersons?: number;
  kind?: string;
}

/** The quote columns the board reads (structural — `GroupFunctionQuote`). */
export interface BoardQuote {
  bmi_reservation_id: string;
  contract_short_id: string | null;
  status: string;
  total_cents: number | string;
  tax_cents: number | string;
  deposit_due_cents: number | string;
  balance_cents: number | string;
  collected_cents: number | string;
  deposit_paid_at: string | null;
  contract_signed_at: string | null;
  contract_sent_at: string | null;
  balance_paid_at: string | null;
  square_dayof_order_id: string | null;
  square_gift_card_gan: string | null;
}

function cents(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
}

function isGfStatus(value: string): value is GfStatus {
  return Object.prototype.hasOwnProperty.call(GF_STATUS_META, value);
}

/** `group_function_quotes` row → the board's contract shape. */
export function contractView(q: BoardQuote): EventContractView {
  const depositDue = cents(q.deposit_due_cents);
  return {
    shortId: q.contract_short_id,
    status: isGfStatus(q.status) ? q.status : "pending",
    totalCents: cents(q.total_cents),
    taxCents: cents(q.tax_cents),
    depositDueCents: depositDue,
    balanceCents: cents(q.balance_cents),
    collectedCents: cents(q.collected_cents),
    depositPaidAt: q.deposit_paid_at,
    signedAt: q.contract_signed_at,
    sentAt: q.contract_sent_at,
    balancePaidAt: q.balance_paid_at,
    dayofOrderId: q.square_dayof_order_id,
    giftCardGan: q.square_gift_card_gan,
    postPaid: depositDue === 0,
  };
}

export const NO_CONTRACT_PILL: EventPill = {
  kind: "none",
  label: "no contract",
  chip: null,
  gfStatus: null,
};

/** `crm-events.js:246` — the money pill, in the prototype's order. */
export function eventPill(c: EventContractView | null): EventPill {
  if (!c) return NO_CONTRACT_PILL;
  if (c.balanceCents === 0 && c.collectedCents > 0) {
    return { kind: "paid", label: "PAID", chip: "won", gfStatus: null };
  }
  if (c.depositPaidAt) return { kind: "deposit", label: "DEPOSIT", chip: "won", gfStatus: null };
  if (c.status === "contract_sent") {
    return { kind: "unsigned", label: "UNSIGNED", chip: "warn", gfStatus: null };
  }
  const meta = GF_STATUS_META[c.status];
  return { kind: "gf", label: meta.label, chip: meta.kind, gfStatus: c.status };
}

/** BMI's own word for a dead event — the board hides these unless asked. */
export function isCancelledState(state: string | null | undefined): boolean {
  return (state || "").toLowerCase().includes("cancel");
}

/**
 * "Past events left unpaid turn red" (the board's own footer). A day that has
 * been and gone with money still outstanding, or a day-of order still open.
 */
export function isPastUnpaid(row: EventRowView, todayYmd: string): boolean {
  if (row.when.slice(0, 10) >= todayYmd) return false;
  if (row.cancelled) return false;
  if (!row.contract) return false;
  if (row.contract.status === "completed") return false;
  return row.contract.balanceCents > 0 || row.contract.collectedCents < row.contract.totalCents;
}

export interface MergeInput {
  centre: CentreCode;
  reservations: readonly BoardReservation[];
  quotesByProjectId: ReadonlyMap<string, BoardQuote>;
  leadsByProjectId: ReadonlyMap<string, EventLeadLink>;
  foodOutByProjectId: ReadonlyMap<string, EventFoodOut>;
  includeCancelled: boolean;
}

/**
 * One day's rows. Online (self-serve) reservations are dropped — this board is
 * the group-function view of the Daily Events board, the same split
 * `applyViewTypeFilter(…, "group")` makes.
 */
export function mergeEventRows(input: MergeInput): EventRowView[] {
  const rows: EventRowView[] = [];
  for (const r of input.reservations) {
    const cancelled = isCancelledState(r.state);
    if (cancelled && !input.includeCancelled) continue;
    const quote = input.quotesByProjectId.get(r.id) ?? null;
    const contract = quote ? contractView(quote) : null;
    const totalCents = contract ? contract.totalCents : Math.round((r.balance || 0) * 100);
    rows.push({
      projectId: r.id,
      number: r.number || "",
      title: r.name || r.personName || "",
      personName: r.personName || "",
      when: r.when,
      persons: Number(r.persons) || 0,
      registered: typeof r.registeredPersons === "number" ? r.registeredPersons : null,
      stateName: r.state || "",
      stateId: r.stateId ?? null,
      responsible: r.responsible || "",
      centre: input.centre,
      balance: Number(r.balance) || 0,
      totalCents,
      collectedCents: contract ? contract.collectedCents : 0,
      foodOut: input.foodOutByProjectId.get(r.id) ?? EMPTY_FOOD_OUT,
      lead: input.leadsByProjectId.get(r.id) ?? null,
      contract,
      pill: eventPill(contract),
      cancelled,
    });
  }
  rows.sort((a, b) => a.when.localeCompare(b.when) || a.number.localeCompare(b.number));
  return rows;
}

/** A day band's header numbers: persons, collected / total. */
export function bandTotals(events: readonly EventRowView[]): {
  persons: number;
  totalCents: number;
  collectedCents: number;
} {
  let persons = 0;
  let totalCents = 0;
  let collectedCents = 0;
  for (const e of events) {
    persons += e.persons;
    totalCents += e.totalCents;
    collectedCents += e.collectedCents;
  }
  return { persons, totalCents, collectedCents };
}

export function makeBand(
  date: string,
  todayYmd: string,
  events: EventRowView[],
  error: string | null = null,
): EventDayBand {
  return { date, isToday: date === todayYmd, events, ...bandTotals(events), error };
}

/** The days a view covers: one for `day`, `date` + 6 for `week`. */
export function dayRange(startYmd: string, view: EventsView): string[] {
  const n = view === "week" ? EVENTS_WEEK_DAYS : 1;
  return Array.from({ length: n }, (_, i) => (i === 0 ? startYmd : shiftYmd(startYmd, i)));
}

/** Prev / Next move a whole band: one day, or a whole week. */
export function stepDate(startYmd: string, view: EventsView, direction: -1 | 1): string {
  return shiftYmd(startYmd, direction * (view === "week" ? EVENTS_WEEK_DAYS : 1));
}

/**
 * The next few months as jump targets, each the FIRST of its month.
 *
 * Owner, 2026-09-14: "Add date and range filter for events page. Plus ability
 * to quickly select certain months." Reaching November meant about ten presses
 * of the Next arrow, and Prev/Next/Today cannot express "show me December".
 *
 * Anchored on the month of the date being viewed, not on today, so stepping
 * forward and then picking a month behaves the way the strip already reads.
 * The first entry is the current month so there is always a way back to it.
 */
export function monthJumps(fromYmd: string, count = 6): Array<{ ymd: string; label: string }> {
  const [y, m] = fromYmd.split("-").map(Number);
  if (!y || !m) return [];
  const out: Array<{ ymd: string; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const total = m - 1 + i;
    const year = y + Math.floor(total / 12);
    const month = (total % 12) + 1;
    const ymd = `${year}-${String(month).padStart(2, "0")}-01`;
    out.push({
      ymd,
      // The year only when it is not the one we started in, so the strip stays
      // short until it actually crosses into January.
      label: MONTH_SHORT[month - 1] + (year === y ? "" : ` ${String(year).slice(2)}`),
    });
  }
  return out;
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
