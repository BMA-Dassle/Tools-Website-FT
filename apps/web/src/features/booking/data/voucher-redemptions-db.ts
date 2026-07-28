/**
 * Voucher-redemption audit ledger (Neon) — the SERVER-side record that a BMI
 * voucher was applied to a bill. BMI is the system of record for the voucher
 * itself (issue/consume); this table exists so:
 *
 *   1. The charge path (unified-reserve) verifies coverage against a row WE
 *      wrote server-side — never against the client session's claim. A session
 *      claiming a voucher with no 'applied' row for its bill hard-fails the
 *      reserve (displayed==charged protection).
 *   2. Persist-first (house rule): the guest's code is recorded at capture,
 *      independent of what BMI does later, so a settle-time dispute is always
 *      reconstructable.
 *
 * States: applied → charged (reserve succeeded) | removed (guest cleared /
 * teardown). Codes are NOT locked at BMI-apply (probe 2026-07-27), so a stale
 * 'applied' row on an abandoned bill burns nothing.
 */

import { sql, isDbConfigured } from "@ft/db";

export interface VoucherRedemptionRow {
  id: number;
  code: string;
  billId: string;
  voucherOrderItemId: string;
  compName: string | null;
  clientKey: string;
  source: string;
  state: "applied" | "charged" | "removed";
  createdAt: string;
  chargedAt: string | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS booking_voucher_redemptions (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        bill_id TEXT NOT NULL,
        voucher_order_item_id TEXT NOT NULL,
        comp_name TEXT,
        client_key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'kiosk',
        state TEXT NOT NULL DEFAULT 'applied',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        charged_at TIMESTAMPTZ
      )
    `;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS bvr_bill_code ON booking_voucher_redemptions (bill_id, code)
    `;
  })();
  return schemaReady;
}

function decode(r: Record<string, unknown>): VoucherRedemptionRow {
  return {
    id: Number(r.id),
    code: String(r.code),
    billId: String(r.bill_id),
    voucherOrderItemId: String(r.voucher_order_item_id),
    compName: r.comp_name == null ? null : String(r.comp_name),
    clientKey: String(r.client_key),
    source: String(r.source),
    state: String(r.state) as VoucherRedemptionRow["state"],
    createdAt: String(r.created_at),
    chargedAt: r.charged_at == null ? null : String(r.charged_at),
  };
}

/** Upsert on (bill, code) — a re-apply after remove flips the row back. */
export async function recordVoucherApplied(args: {
  code: string;
  billId: string;
  voucherOrderItemId: string;
  compName: string | null;
  clientKey: string;
  source: "kiosk" | "web";
}): Promise<void> {
  if (!isDbConfigured()) throw new Error("DB not configured");
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO booking_voucher_redemptions
      (code, bill_id, voucher_order_item_id, comp_name, client_key, source, state)
    VALUES
      (${args.code}, ${args.billId}, ${args.voucherOrderItemId}, ${args.compName},
       ${args.clientKey}, ${args.source}, 'applied')
    ON CONFLICT (bill_id, code) DO UPDATE SET
      voucher_order_item_id = EXCLUDED.voucher_order_item_id,
      comp_name = EXCLUDED.comp_name,
      state = 'applied'
  `;
}

/** The bill's live voucher row, if any (reserve-time verification read). */
export async function getAppliedVoucherForBill(
  billId: string,
): Promise<VoucherRedemptionRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM booking_voucher_redemptions
    WHERE bill_id = ${billId} AND state = 'applied'
    ORDER BY created_at DESC LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length ? decode(rows[0]) : null;
}

export async function markVoucherRemoved(billId: string, code: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE booking_voucher_redemptions SET state = 'removed'
    WHERE bill_id = ${billId} AND code = ${code}
  `;
}

/** Best-effort post-charge stamp (audit trail; never fails a captured charge). */
export async function markVoucherCharged(billId: string, code: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE booking_voucher_redemptions SET state = 'charged', charged_at = NOW()
    WHERE bill_id = ${billId} AND code = ${code} AND state = 'applied'
  `;
}
