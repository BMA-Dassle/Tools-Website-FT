/**
 * `attentionReasons` — ported line for line from the prototype
 * (`crm-mockups/crm-events.js:192-201`). The copy is verbatim; only the inputs
 * changed, from the prototype's seeded object to the real
 * `group_function_quotes` row.
 *
 * PURE, and deliberately so: the same predicate decides the "Needs attention"
 * window, the tile count and the pills on every row, so the three can never
 * disagree. The clock arrives as `now` — never `new Date()` inside — because
 * the runner's clock is UTC in CI and "days out" is an ET calendar count.
 *
 * Two prototype fields have real equivalents rather than seeded flags:
 *   `pastUnpaidDayof` → a day-of Square order that exists, was never settled,
 *   and whose event has passed (`square_dayof_order_id IS NOT NULL AND
 *   square_settled_order_id IS NULL AND event_date < today`);
 *   `awaiting approval N d` counts from the row's `created_at`, the moment the
 *   dispatch cron parked it for approval, rather than from its first audit row
 *   (which a list read does not load).
 *
 * `ATTENTION_SQL` is the same set expressed for Postgres, so the list query
 * and the counts are exact instead of a scan-and-hope. Every OR-branch below
 * has a matching clause there; a change to one is a change to both, and
 * `attention.test.ts` pins that they agree on a fixture per branch.
 */

import { daysOut } from "../../core/dates";
import type { GfStatus } from "../../core/types";
import type { AttentionReason } from "../contracts";

/** Statuses that end a contract's life — reason 8 never fires for them. */
export const CLOSED_FOR_ATTENTION: readonly GfStatus[] = ["completed", "cancelled", "denied"];

/** Two days, in minutes — the prototype's `ageMin(c.sentAt) > 2880`. */
export const UNSIGNED_AGE_MINUTES = 2880;

/** The fields `attentionReasons` needs; anything row-shaped satisfies it. */
export interface AttentionInput {
  status: GfStatus;
  /** YYYY-MM-DD */
  eventDate: string;
  sentAt: string | null;
  balanceCents: number;
  createdAt: string;
  dayofOrderId: string | null;
  settledOrderId: string | null;
}

function ageMinutes(iso: string | null, now: Date): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 60_000));
}

/** The prototype's `pastUnpaidDayof`, derived from the real columns. */
export function pastUnpaidDayof(row: AttentionInput, now: Date): boolean {
  const days = daysOut(row.eventDate, now);
  return (
    Boolean(row.dayofOrderId) && !row.settledOrderId && days < 0 && days >= -DAYOF_ATTENTION_DAYS
  );
}

/**
 * A past event with nothing outstanding is FINISHED, whatever its status says.
 *
 * Owner, 2026-09-13, looking at the live list: "like doesn't need attention
 * basically". Fourteen past events were being flagged and twelve of them were
 * settled at a zero balance — the event ran, the money is in, and only the
 * status was never advanced to completed. Worse, the reasons compounded: one
 * row read "unsigned 107 d · event in -105 d, unsigned · event passed, not
 * closed", three alarms for a job that finished in June.
 *
 * Guarding each branch separately would have left the first two of those three
 * still shouting, so the rule is stated once, here, and it is the money that
 * decides. An open day-of Square order still counts as outstanding, so a past
 * event with one keeps its place in the list even at a zero balance.
 */
export function pastAndSettled(row: AttentionInput, now: Date): boolean {
  return daysOut(row.eventDate, now) < 0 && row.balanceCents <= 0 && !pastUnpaidDayof(row, now);
}

export function attentionReasons(row: AttentionInput, now: Date): AttentionReason[] {
  const out: AttentionReason[] = [];
  const days = daysOut(row.eventDate, now);
  const openDayof = pastUnpaidDayof(row, now);

  if (pastAndSettled(row, now)) return out;

  if (row.status === "pending_approval") {
    out.push({
      t: `awaiting approval ${Math.floor(ageMinutes(row.createdAt, now) / 1440)} d`,
      k: "warn",
    });
  }
  if (row.status === "contract_sent" && ageMinutes(row.sentAt, now) > UNSIGNED_AGE_MINUTES) {
    out.push({ t: `unsigned ${Math.floor(ageMinutes(row.sentAt, now) / 1440)} d`, k: "warn" });
  }
  if (row.status === "contract_sent" && days <= 7) {
    out.push({ t: `event in ${days} d, unsigned`, k: "crit" });
  }
  if (row.status === "resign_required") out.push({ t: "needs re-sign", k: "crit" });
  if (row.status === "balance_link_sent") out.push({ t: "payment link outstanding", k: "warn" });
  if (row.status === "deposit_paid" && days <= 3 && row.balanceCents > 0) {
    out.push({ t: "balance not yet charged", k: "crit" });
  }
  if (openDayof) out.push({ t: "day-of order still open", k: "crit" });
  // Reached only when the event is past AND money is still outstanding, because
  // `pastAndSettled` returned early otherwise. The amount is named so the row
  // says what is actually wrong with it.
  if (days < 0 && !CLOSED_FOR_ATTENTION.includes(row.status) && !openDayof) {
    out.push({
      t: `event passed, $${Math.round(row.balanceCents / 100).toLocaleString("en-US")} still owed`,
      k: "crit",
    });
  }
  return out;
}

/** crit beats warn — the row's pill colour (prototype `reasons.some(k === "crit")`). */
export function attentionTone(reasons: readonly AttentionReason[]): AttentionKindOrNull {
  if (reasons.some((r) => r.k === "crit")) return "crit";
  if (reasons.length > 0) return "warn";
  return null;
}

type AttentionKindOrNull = "warn" | "crit" | null;

/**
 * The same set, for Postgres. `$1` is today's ET calendar day (YYYY-MM-DD) and
 * `$2` is the "unsigned for two days" cut-off as an ISO instant; the caller
 * binds both so the clock is still an input, never `now()` inside the database
 * (where it is UTC and would slide the ET day boundary).
 *
 * Branch for branch with `attentionReasons` above, in the same order.
 */
/**
 * How long an unsettled day-of order stays actionable.
 *
 * On 2026-09-13 this ONE branch was producing 229 of the 312 rows in "needs
 * attention" — every past event whose Square day-of order had no settled id,
 * back to 28 May. That is not 229 jobs a planner can do today; it is one
 * systemic problem wearing 229 hats, and it was burying the 8 approvals and 74
 * unsigned contracts that ARE work. (Only 44 quotes in the whole table carry a
 * settled id, so the settle rail itself is worth a look — recorded here so the
 * next reader does not rediscover it from scratch.)
 *
 * Two weeks is the window where chasing one is realistic. Older than that and
 * it belongs in a backlog report, not in a daily list.
 */
export const DAYOF_ATTENTION_DAYS = 14;

export const ATTENTION_SQL = `(
  -- A PAST EVENT WITH NOTHING OUTSTANDING IS FINISHED, whatever its status says.
  -- Mirrors pastAndSettled(): stated ONCE, as a gate over every branch below,
  -- rather than guarded branch by branch. Owner, 2026-09-13, on the live list:
  -- "like doesn't need attention basically" — 14 past events were flagged and
  -- 12 were settled at a zero balance, their status simply never advanced to
  -- 'completed' after the event ran. The reasons also compounded: one row read
  -- unsigned 107 d, then event in -105 d unsigned, then event passed not
  -- closed. Three alarms for a job that finished in June. Guarding only the
  -- last branch would have left the first two still shouting.
  -- An open day-of Square order counts as outstanding, so such a row keeps its
  -- place even at a zero balance.
  -- (No currency symbols in this comment: the branch-parity test scans this
  -- string for placeholders and a dollar amount reads as one.)
  NOT (
        event_date < $1::date
    AND balance_cents <= 0
    AND NOT (square_dayof_order_id IS NOT NULL AND square_settled_order_id IS NULL)
  )
  AND (
     status = 'pending_approval'
  OR (status = 'contract_sent' AND contract_sent_at IS NOT NULL AND contract_sent_at < $2::timestamptz)
  OR (status = 'contract_sent' AND event_date <= ($1::date + 7))
  OR status = 'resign_required'
  OR status = 'balance_link_sent'
  OR (status = 'deposit_paid' AND event_date <= ($1::date + 3) AND balance_cents > 0)
  OR (square_dayof_order_id IS NOT NULL AND square_settled_order_id IS NULL
      AND event_date < $1::date AND event_date >= ($1::date - 14))
  -- Reached only when the gate above let the row through, i.e. the event is
  -- past AND something is still outstanding.
  OR (event_date < $1::date AND status NOT IN ('completed','cancelled','denied'))
  )
)`;

/** The day-of half of the prototype's count expression, on its own. */
export const PAST_UNPAID_DAYOF_SQL = `(
  square_dayof_order_id IS NOT NULL AND square_settled_order_id IS NULL AND event_date < $1::date
)`;
