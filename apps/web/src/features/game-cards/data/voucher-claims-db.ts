/**
 * Voucher ITEM claims (Neon) — the single-use authority for every voucher we
 * redeem, whoever issued it.
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
 * has to be GLOBAL.
 *
 * PER ITEM, NOT PER CODE (owner 2026-07-29: "each of our native voucher may have
 * more than one item"). One of our vouchers can carry a game card AND laser tag,
 * and those are redeemed at different places on different days — so the unique
 * key is (code, item_index). Keying on `code` alone would let the first
 * redemption silently destroy the rest of the voucher's value. A BMI-issued
 * voucher is always item_index 0 (we can't split a BMI bundle — see
 * voucher-card.ts).
 *
 * CLAIM IS A COMPARE-AND-SET, in one statement, so two kiosks scanning the same
 * code at the same moment cannot both win (the Neon HTTP driver runs each
 * statement as its own transaction — there is no multi-statement transaction to
 * lean on):
 *
 *   INSERT … ON CONFLICT (code, item_index) DO UPDATE … WHERE status = 'released'
 *   RETURNING id      -- zero rows back = someone already holds that item
 *
 * One row per (code, item), forever — the row is the audit trail. `released` is only
 * ever written when we know NOTHING was dispensed (guest abandoned at the
 * insert prompt, dispenser fault before a card left the stacker). Once a blank
 * has physically moved, the claim stands even if the credit failed: the txn row
 * is `pending` and the reconcile cron drives it forward. Releasing there would
 * hand out a second card for one voucher.
 */

import { sql, isDbConfigured } from "@ft/db";

/**
 * claimed  — held by an in-flight redemption (dispense or cart charge).
 * released — handed back; the code is claimable again.
 * spent    — terminal: the charge it covered was CAPTURED. Distinguishes a
 *            finished cart claim from a stranded one, so the stale-claim sweep
 *            can release abandoned checkouts without ever freeing a spent code.
 */
export type VoucherClaimStatus = "claimed" | "released" | "spent";

/**
 * WHO issued the voucher this claim covers.
 *   bmi     — minted in BMI Office; BMI is the registry, we peek to learn what
 *             it is, and BMI never records the redemption (no consume endpoint).
 *   native  — minted by us (`HPW…`, see vouchers/codes.ts); the `vouchers` table
 *             is the registry and no external call is involved at all.
 *   groupon — a Groupon voucher (`groupon_units` is our registry). Groupon is
 *             told ONCE, all-or-nothing, and thereafter reports the code
 *             `redeemed` forever — so it cannot answer "which items are left".
 *             That is precisely why per-item single use has to live here.
 * All three share THIS table because single-use is the same problem either way,
 * and one atomic CAS per code is the only way to get it right.
 */
export type VoucherIssuer = "bmi" | "native" | "groupon";

export interface VoucherClaimRow {
  id: number;
  code: string;
  /** Which line of the voucher this claim spends (0 for single-item / BMI). */
  itemIndex: number;
  issuer: VoucherIssuer;
  compName: string | null;
  packageId: string;
  txnId: string;
  locationCode: number;
  clientKey: string | null;
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
      CREATE TABLE IF NOT EXISTS voucher_claims (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        -- Which line of the voucher this claim spends. 0 for single-item and for
        -- every BMI-issued voucher.
        item_index INTEGER NOT NULL DEFAULT 0,
        issuer TEXT NOT NULL DEFAULT 'bmi',
        comp_name TEXT,
        package_id TEXT NOT NULL,
        txn_id TEXT NOT NULL,
        location_code INTEGER NOT NULL,
        -- BMI clientKey; NULL for our own vouchers (no external system).
        client_key TEXT,
        kiosk_id TEXT,
        status TEXT NOT NULL DEFAULT 'claimed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at TIMESTAMPTZ,
        released_reason TEXT,
        UNIQUE (code, item_index)
      )
    `;
    // The load path and the reconcile cron both authorise by txn_id.
    await q`CREATE INDEX IF NOT EXISTS vc_txn ON voucher_claims (txn_id)`;
    await q`CREATE INDEX IF NOT EXISTS vc_code ON voucher_claims (code)`;
  })();
  return schemaReady;
}

function decode(r: Record<string, unknown>): VoucherClaimRow {
  return {
    id: Number(r.id),
    code: String(r.code),
    itemIndex: Number(r.item_index ?? 0),
    issuer: String(r.issuer ?? "bmi") as VoucherIssuer,
    compName: r.comp_name == null ? null : String(r.comp_name),
    packageId: String(r.package_id),
    txnId: String(r.txn_id),
    locationCode: Number(r.location_code),
    clientKey: r.client_key == null ? null : String(r.client_key),
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
  /** Which line of the voucher to spend. 0 for single-item / BMI vouchers. */
  itemIndex?: number;
  issuer: VoucherIssuer;
  compName: string | null;
  packageId: string;
  txnId: string;
  locationCode: number;
  clientKey?: string | null;
  kioskId?: string | null;
}): Promise<ClaimResult> {
  if (!isDbConfigured()) throw new Error("game-card vouchers: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO voucher_claims
      (code, item_index, issuer, comp_name, package_id, txn_id, location_code, client_key,
       kiosk_id, status)
    VALUES
      (${args.code}, ${args.itemIndex ?? 0}, ${args.issuer}, ${args.compName}, ${args.packageId},
       ${args.txnId}, ${args.locationCode}, ${args.clientKey ?? null}, ${args.kioskId ?? null},
       'claimed')
    ON CONFLICT (code, item_index) DO UPDATE SET
      issuer = EXCLUDED.issuer,
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
    WHERE voucher_claims.status = 'released'
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
    UPDATE voucher_claims
    SET status = 'released', released_at = NOW(), released_reason = ${reason}
    WHERE code = ${code} AND txn_id = ${txnId} AND status = 'claimed'
  `;
}

/**
 * Terminal stamp after the charge a cart claim covered was CAPTURED. Guarded on
 * txn_id like release, and only ever forward from 'claimed' — a released (re-
 * claimable) or already-spent row is left alone. Returns whether a row moved.
 */
export async function markVoucherClaimSpent(code: string, txnId: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    UPDATE voucher_claims
    SET status = 'spent'
    WHERE code = ${code} AND txn_id = ${txnId} AND status = 'claimed'
    RETURNING id
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

/**
 * Cart-charge claims (txn_id `cart-…`, minted only by unified-reserve) still
 * 'claimed' after `minAgeMinutes` — the abandoned-checkout candidates the
 * reconcile sweep releases. Dispense claims (UUID txn ids) never match.
 */
export async function listStaleCartClaims(minAgeMinutes: number): Promise<VoucherClaimRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM voucher_claims
    WHERE status = 'claimed'
      AND txn_id LIKE 'cart-%'
      AND created_at < NOW() - make_interval(mins => ${minAgeMinutes})
    ORDER BY created_at ASC
    LIMIT 200
  `) as Record<string, unknown>[];
  return rows.map(decode);
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
    SELECT * FROM voucher_claims
    WHERE txn_id = ${txnId} AND status = 'claimed'
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0 ? decode(rows[0]) : null;
}

/**
 * EVERY claim row for a code, item order. This is what tells staff (and the
 * guest) "1 of 2 items used" — a multi-item voucher's redemption state is the
 * set of live claims across its items, nothing else.
 */
export async function getClaimsByCode(code: string): Promise<VoucherClaimRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM voucher_claims WHERE code = ${code} ORDER BY item_index ASC
  `) as Record<string, unknown>[];
  return rows.map(decode);
}

/**
 * The item indexes NOT available on this code.
 *
 * `claimed` AND `spent` both count. Only `released` frees an item — which is
 * exactly the condition the claim CAS above guards on (`WHERE status =
 * 'released'`), so this predicate and that statement have to agree or the two
 * disagree about the same voucher.
 *
 * This matched `claimed` only, which meant a cart claim that reached `spent`
 * (its charge CAPTURED) read as available again: `/v/{code}` offered value the
 * guest had already used, `fullySpent` never became true, and the dispense
 * picker would choose that leg and then be refused by the CAS with a confusing
 * error instead of moving on to the next unspent one.
 */
export async function spentItemIndexes(code: string): Promise<Set<number>> {
  const rows = await getClaimsByCode(code);
  return new Set(
    rows.filter((r) => r.status === "claimed" || r.status === "spent").map((r) => r.itemIndex),
  );
}
