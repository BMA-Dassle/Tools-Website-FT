/**
 * Money and value state on `deal_purchases` — the columns the original table
 * shipped without, added here rather than in `deal-purchases-db.ts`.
 *
 * SEPARATE FILE, again on purpose: that module's `ensureSchema()` is a single
 * memoised promise several in-flight branches are editing, and it is the one
 * place in this feature guaranteed to conflict. Everything here is additive and
 * idempotent, so the two can land in either order.
 *
 * WHY THESE COLUMNS EXIST AT ALL. `refunded_at` / `refund_reason` on the base
 * table are a lie by now: they are written ONLY by the void action, which
 * explicitly does not touch money — the route it lives in tells staff to go
 * refund the card by hand in Square. Reading them as a refund would make the
 * first real refund indistinguishable from a void in every report built on this
 * data, and would quietly corrupt the buyer-cap arithmetic.
 *
 * So the two concepts get separate homes:
 *
 *   vouchers_voided_at  the value was killed, the money was deliberately left
 *                       alone — fraud, a wrong recipient, a contested charge
 *   refunded_packs      money actually went back, and how much of the purchase
 *   refunded_cents      it covered
 *
 * `refunded_at` is left in place, no longer written, and backfilled into
 * `vouchers_voided_at` so history reads correctly. Dropping it is a later
 * migration, once nothing reads it.
 */

import { sql, isDbConfigured } from "@ft/db";

let ready: Promise<void> | null = null;

export function ensureDealMoneyColumns(): Promise<void> {
  ready ??= (async () => {
    const q = sql();
    // ALTER, never CREATE: the base table's CREATE TABLE IF NOT EXISTS never
    // runs again on an existing table, which the `combine` column's comment
    // already learned the hard way.
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS vouchers_voided_at TIMESTAMPTZ`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS vouchers_voided_reason TEXT`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS refunded_packs INTEGER NOT NULL DEFAULT 0`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS fully_refunded_at TIMESTAMPTZ`;

    // One-time backfill of the mislabelled history. Guarded on the destination
    // being NULL because this runs on every cold start: without the guard it
    // would overwrite a genuine later void with the legacy timestamp forever.
    await q`
      UPDATE deal_purchases
      SET vouchers_voided_at = refunded_at,
          vouchers_voided_reason = refund_reason
      WHERE refunded_at IS NOT NULL AND vouchers_voided_at IS NULL
    `;
  })();
  return ready;
}

/**
 * Record that a purchase's vouchers were killed.
 *
 * Writes ONLY the void columns. It deliberately does not touch `refunded_at`,
 * so from here on that column stops accumulating new lies.
 */
export async function markDealVouchersVoided(id: number, reason: string): Promise<void> {
  if (!isDbConfigured()) throw new Error("DB not configured — refusing to void without a record");
  await ensureDealMoneyColumns();
  const q = sql();
  await q`
    UPDATE deal_purchases
    SET vouchers_voided_at = COALESCE(vouchers_voided_at, NOW()),
        vouchers_voided_reason = ${reason.slice(0, 500)}
    WHERE id = ${id}
  `;
}

export interface DealMoneyState {
  vouchersVoidedAt: string | null;
  vouchersVoidedReason: string | null;
  refundedPacks: number;
  refundedCents: number;
  fullyRefundedAt: string | null;
}

/** The money/value state for one purchase. */
export async function getDealMoneyState(id: number): Promise<DealMoneyState | null> {
  if (!isDbConfigured()) return null;
  await ensureDealMoneyColumns();
  const q = sql();
  const rows = (await q`
    SELECT vouchers_voided_at, vouchers_voided_reason, refunded_packs, refunded_cents, fully_refunded_at
    FROM deal_purchases WHERE id = ${id}
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return decodeMoneyState(r);
}

/** Same shape, for a set of purchases the board is already listing. */
export async function getDealMoneyStates(ids: number[]): Promise<Map<number, DealMoneyState>> {
  const out = new Map<number, DealMoneyState>();
  if (!isDbConfigured() || ids.length === 0) return out;
  await ensureDealMoneyColumns();
  const q = sql();
  const rows = (await q`
    SELECT id, vouchers_voided_at, vouchers_voided_reason, refunded_packs, refunded_cents, fully_refunded_at
    FROM deal_purchases WHERE id = ANY(${ids}::bigint[])
  `) as Record<string, unknown>[];
  for (const r of rows) out.set(Number(r.id), decodeMoneyState(r));
  return out;
}

function decodeMoneyState(r: Record<string, unknown>): DealMoneyState {
  return {
    vouchersVoidedAt: r.vouchers_voided_at
      ? new Date(r.vouchers_voided_at as string).toISOString()
      : null,
    vouchersVoidedReason: (r.vouchers_voided_reason as string | null) ?? null,
    refundedPacks: Number(r.refunded_packs ?? 0),
    refundedCents: Number(r.refunded_cents ?? 0),
    fullyRefundedAt: r.fully_refunded_at
      ? new Date(r.fully_refunded_at as string).toISOString()
      : null,
  };
}

/** Test seam — lets a suite re-run the migration against a fresh mock. */
export function _resetDealMoneyColumns(): void {
  ready = null;
}
