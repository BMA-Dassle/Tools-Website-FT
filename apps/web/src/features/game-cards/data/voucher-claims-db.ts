/**
 * Game Zone voucher CLAIMS (Neon) — the single-use authority for BMI comp
 * vouchers redeemed as dispensed cards.
 *
 * WHY THIS TABLE EXISTS. For every other voucher kind, BMI is the system of
 * record for consumption: `applyCode` puts a comp line on a bill and BMI marks
 * the code used when the order is PROCESSED. A Game Zone comp has no money leg
 * — probed live 2026-07-27, a comp-only bill AUTO-CANCELS and codes are NOT
 * locked at apply — so no order is ever processed and BMI's `Used` column
 * stays 0 forever. Without a claim of our own, one photographed code would
 * dispense an unlimited number of cards until its 2027 expiry.
 *
 * `booking_voucher_redemptions` cannot serve this: it is UNIQUE (bill_id, code)
 * on purpose (a race comp legitimately reappears across bills). Single-use here
 * has to be GLOBAL, on the code alone.
 *
 * CLAIM IS A COMPARE-AND-SET, in one statement, so two kiosks scanning the same
 * code at the same moment cannot both win (the Neon HTTP driver runs each
 * statement as its own transaction — there is no multi-statement transaction to
 * lean on):
 *
 *   INSERT … ON CONFLICT (code) DO UPDATE … WHERE status = 'released'
 *   RETURNING id      -- zero rows back = someone already holds it
 *
 * One row per code, forever — the row is the audit trail. `released` is only
 * ever written when we know NOTHING was dispensed (guest abandoned at the
 * insert prompt, dispenser fault before a card left the stacker). Once a blank
 * has physically moved, the claim stands even if the credit failed: the txn row
 * is `pending` and the reconcile cron drives it forward. Releasing there would
 * hand out a second card for one voucher.
 */

import { sql, isDbConfigured } from "@ft/db";

export type VoucherClaimStatus = "claimed" | "released";

export interface VoucherClaimRow {
  id: number;
  code: string;
  compName: string | null;
  packageId: string;
  txnId: string;
  locationCode: number;
  clientKey: string;
  kioskId: string | null;
  status: VoucherClaimStatus;
  createdAt: string;
  releasedAt: string | null;
  releasedReason: string | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS game_card_voucher_claims (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        comp_name TEXT,
        package_id TEXT NOT NULL,
        txn_id TEXT NOT NULL,
        location_code INTEGER NOT NULL,
        client_key TEXT NOT NULL,
        kiosk_id TEXT,
        status TEXT NOT NULL DEFAULT 'claimed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at TIMESTAMPTZ,
        released_reason TEXT
      )
    `;
    // The load path and the reconcile cron both authorise by txn_id.
    await q`CREATE INDEX IF NOT EXISTS gcvc_txn ON game_card_voucher_claims (txn_id)`;
  })();
  return schemaReady;
}

function decode(r: Record<string, unknown>): VoucherClaimRow {
  return {
    id: Number(r.id),
    code: String(r.code),
    compName: r.comp_name == null ? null : String(r.comp_name),
    packageId: String(r.package_id),
    txnId: String(r.txn_id),
    locationCode: Number(r.location_code),
    clientKey: String(r.client_key),
    kioskId: r.kiosk_id == null ? null : String(r.kiosk_id),
    status: String(r.status) as VoucherClaimStatus,
    createdAt: String(r.created_at),
    releasedAt: r.released_at == null ? null : String(r.released_at),
    releasedReason: r.released_reason == null ? null : String(r.released_reason),
  };
}

export type ClaimResult =
  | { ok: true; claim: VoucherClaimRow }
  /** Someone else holds this code (or it was already spent). */
  | { ok: false; reason: "already_claimed" };

/**
 * Atomically take ownership of `code` for one dispense. Returns
 * `already_claimed` when a live claim exists — that is a SPENT voucher, and the
 * caller must refuse the guest, never fall through to dispensing.
 *
 * THROWS if the DB is unconfigured: with no claim store there is no single-use
 * guarantee, and dispensing anyway would be handing out free cards.
 */
export async function claimVoucher(args: {
  code: string;
  compName: string | null;
  packageId: string;
  txnId: string;
  locationCode: number;
  clientKey: string;
  kioskId?: string | null;
}): Promise<ClaimResult> {
  if (!isDbConfigured()) throw new Error("game-card vouchers: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO game_card_voucher_claims
      (code, comp_name, package_id, txn_id, location_code, client_key, kiosk_id, status)
    VALUES
      (${args.code}, ${args.compName}, ${args.packageId}, ${args.txnId},
       ${args.locationCode}, ${args.clientKey}, ${args.kioskId ?? null}, 'claimed')
    ON CONFLICT (code) DO UPDATE SET
      comp_name = EXCLUDED.comp_name,
      package_id = EXCLUDED.package_id,
      txn_id = EXCLUDED.txn_id,
      location_code = EXCLUDED.location_code,
      client_key = EXCLUDED.client_key,
      kiosk_id = EXCLUDED.kiosk_id,
      status = 'claimed',
      created_at = NOW(),
      released_at = NULL,
      released_reason = NULL
    WHERE game_card_voucher_claims.status = 'released'
    RETURNING *
  `) as Record<string, unknown>[];
  // Zero rows: the ON CONFLICT target existed and its status was NOT 'released',
  // so the guarded UPDATE matched nothing. The code is spent (or in flight).
  if (rows.length === 0) return { ok: false, reason: "already_claimed" };
  return { ok: true, claim: decode(rows[0]) };
}

/**
 * Hand a claim back — ONLY safe when no card left the stacker. Guarded on
 * txn_id so a late release from an abandoned attempt can never free a code that
 * a LATER attempt has since claimed.
 */
export async function releaseVoucherClaim(
  code: string,
  txnId: string,
  reason: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE game_card_voucher_claims
    SET status = 'released', released_at = NOW(), released_reason = ${reason}
    WHERE code = ${code} AND txn_id = ${txnId} AND status = 'claimed'
  `;
}

/**
 * The live claim behind a ledger row, or null. This is the authorisation read
 * for a `kind='voucher'` load — the money path's equivalent of "was it
 * charged?". Never infer authorisation from the txn row alone: an orphan row
 * (claim taken, insert raced) must credit nothing.
 */
export async function getLiveClaimForTxn(txnId: string): Promise<VoucherClaimRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM game_card_voucher_claims
    WHERE txn_id = ${txnId} AND status = 'claimed'
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0 ? decode(rows[0]) : null;
}

/** Any row for a code (spent or released) — staff lookup / diagnostics. */
export async function getClaimByCode(code: string): Promise<VoucherClaimRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM game_card_voucher_claims WHERE code = ${code} LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0 ? decode(rows[0]) : null;
}
