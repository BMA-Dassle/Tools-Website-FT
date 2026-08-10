/**
 * Captured-money guard for browser-originated BMI bill cancels.
 *
 * Why (2026-08-10, W59702 → $420.68 stranded): every kiosk exit path — idle
 * reset, Start Over, the self-update hard reload — "releases holds" by
 * cancelling the session's BMI bill through the /api/bmi proxy. On 8/10 that
 * unwind fired 58 seconds AFTER the Square Terminal captured the guest's
 * $420.68 (the client never reached reserve-all), and the cancel is what made
 * the incident unrecoverable in place: the captured-no-reserve resume requires
 * the bill alive (reserve-all's BillExpired guard reads it), and every Square
 * idempotency key derives from reserveBaseKey(bmiBillId), so a dead bill can
 * never verify its own payment again. Second occurrence of the class (Chung
 * 7/28). See docs/sop-kiosk-captured-no-reserve-rebuild.md.
 *
 * The rule: an unwind may only release what is still merely HELD. If the
 * tender ledger (kiosk_split_tenders, seed = billId) says money moved and no
 * booking row exists yet, the bill is the resume path's collateral — refuse
 * the cancel and let the resume / tender sweep / staff own it.
 *
 * Scope: ONLY the /api/bmi proxy DELETE (browser-originated cancels). The
 * cancellation cascade (src/features/cancellation/bmi-cancel.ts) and the
 * bmi-cancel-sweep call BMI directly server-side and never pass through this
 * guard — a cancelled-and-refunded booking also has a bowling_reservations
 * row, so it would pass anyway. Tooling can override with ?force=1.
 *
 * Fail-open: a Neon blip must never strand heats on an abandoned bill — BMI's
 * own hold expiry is the backstop for a cancel we wrongly allow through, but
 * nothing recovers heats we wrongly refuse to release.
 */
import { sql } from "@/lib/db";

export interface CancelGuardLedger {
  state: string | null;
  paymentIdCount: number;
}

export interface CancelGuardVerdict {
  blocked: boolean;
  reason: string;
}

/** Ledger states that mean money moved (or is under review as if it had). */
const MONEY_STATES = new Set(["captured", "needs_review"]);

/**
 * Pure decision — unit-tested. Blocked iff the ledger shows money moved AND
 * no non-cancelled booking row exists for the bill AND no explicit override.
 */
export function evaluateCancelGuard(input: {
  ledger: CancelGuardLedger | null;
  activeBookingCount: number;
  force: boolean;
}): CancelGuardVerdict {
  const { ledger, activeBookingCount, force } = input;
  if (force) return { blocked: false, reason: "force override" };
  if (!ledger) return { blocked: false, reason: "no tender ledger row for this bill" };
  const moneyMoved = MONEY_STATES.has(ledger.state ?? "") || ledger.paymentIdCount > 0;
  if (!moneyMoved) {
    return { blocked: false, reason: `ledger state=${ledger.state} with no payments` };
  }
  if (activeBookingCount > 0) {
    return {
      blocked: false,
      reason: `money captured but ${activeBookingCount} booking row(s) exist — normal post-booking cancel`,
    };
  }
  return {
    blocked: true,
    reason:
      `ledger state=${ledger.state} paymentIds=${ledger.paymentIdCount} with NO booking row — ` +
      `captured-no-reserve: the bill is the resume path's anchor`,
  };
}

/**
 * Neon-backed check for a bill id (raw digit string — never Number()'d).
 * Fails OPEN on any database error.
 */
export async function guardBillCancel(billId: string, force: boolean): Promise<CancelGuardVerdict> {
  try {
    const q = sql();
    const ledgerRows = (await q`
      SELECT state, payment_ids
      FROM kiosk_split_tenders
      WHERE seed::text = ${billId}
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{ state: string | null; payment_ids: unknown }>;
    const ledger: CancelGuardLedger | null = ledgerRows.length
      ? {
          state: ledgerRows[0].state,
          paymentIdCount: Array.isArray(ledgerRows[0].payment_ids)
            ? ledgerRows[0].payment_ids.length
            : 0,
        }
      : null;

    // Skip the booking query when the ledger alone already decides it.
    let activeBookingCount = 0;
    if (ledger && (MONEY_STATES.has(ledger.state ?? "") || ledger.paymentIdCount > 0)) {
      const bookingRows = (await q`
        SELECT COUNT(*)::int AS n
        FROM bowling_reservations
        WHERE bmi_bill_id::text = ${billId} AND status <> 'cancelled'
      `) as Array<{ n: number }>;
      activeBookingCount = bookingRows[0]?.n ?? 0;
    }

    return evaluateCancelGuard({ ledger, activeBookingCount, force });
  } catch (err) {
    console.error(
      `[cancel-guard] Neon check failed for bill=${billId} — FAILING OPEN:`,
      err instanceof Error ? err.message : err,
    );
    return { blocked: false, reason: "guard check errored — failed open" };
  }
}
