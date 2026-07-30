/**
 * OUR OWN vouchers — the mint registry (Neon), plus an append-only event log.
 *
 * Only `issuer='native'` vouchers get a row here. BMI-issued vouchers never do:
 * BMI is their registry, and duplicating it would give us two answers to "what
 * is this code worth".
 *
 * DELIBERATELY NO `status` COLUMN. Whether a voucher is spent is answered in
 * exactly ONE place — a live row in `game_card_voucher_claims` — because that
 * table's single atomic CAS is what makes redemption race-safe. A `status` here
 * would be a second writer for the same fact, and the two would drift the first
 * time a claim failed halfway. This table holds only immutable mint facts plus
 * `voided_at` (an issuer decision, not a redemption outcome).
 *
 * The grant is stored EXPLICITLY at mint time. That is the whole advantage of
 * issuing our own: the BMI path has to infer value from free-form comp text
 * behind a regex and a denomination allowlist, and can still be surprised. Here
 * the value is a fact we wrote down.
 */

import { sql, isDbConfigured } from "@ft/db";

/**
 * ONE line of value on a voucher. A voucher carries a LIST of these (owner
 * 2026-07-29: "each of our native voucher may have more than one item").
 *
 * Items are redeemed INDEPENDENTLY — a card+laser voucher is a game card at the
 * kiosk today and laser tag at booking next week — which is why single-use is
 * enforced per (code, itemIndex) in voucher_claims and NOT per code. An item's
 * POSITION in the array is its identity: never reorder or splice a minted
 * voucher's items, or an existing claim would point at different value than it
 * authorised.
 */
export type VoucherItem =
  /** Game Zone value: kiosk dispenses a card, web credits one the guest holds. */
  | { kind: "gamezone"; tokens: number; bonusTokens: number; bonusCashDollars: number }
  /** Attraction admission (laser tag, gel blasters, …). MINTABLE, not yet
   *  redeemable — the cart-coverage rail for self-issued vouchers isn't built,
   *  so redemption refuses with `not_redeemable` rather than silently eating it. */
  | { kind: "attraction"; slug: string; qty: number }
  /** Race entry. Same status as attraction. */
  | { kind: "race"; qty: number };

/** What a single Game Zone item puts on a card. */
export interface VoucherGrantConfig {
  tokens: number;
  bonusTokens: number;
  bonusCashDollars: number;
}

export type VoucherKind = "gamezone" | "mixed";

/** The Game Zone grant for an item, or null if it isn't a Game Zone item. */
export function gameZoneGrant(item: VoucherItem): VoucherGrantConfig | null {
  if (item.kind !== "gamezone") return null;
  return {
    tokens: item.tokens,
    bonusTokens: item.bonusTokens,
    bonusCashDollars: item.bonusCashDollars,
  };
}

/** Short guest-facing label for one item. */
export function voucherItemLabel(item: VoucherItem): string {
  if (item.kind === "gamezone") {
    return item.bonusCashDollars > 0
      ? `$${item.bonusCashDollars} bonus cash`
      : `${item.bonusTokens + item.tokens} bonus tokens`;
  }
  if (item.kind === "attraction") {
    const name = item.slug.replace(/-/g, " ");
    return item.qty > 1 ? `${item.qty} x ${name}` : name;
  }
  return item.qty > 1 ? `${item.qty} x race` : "race";
}

export interface VoucherRow {
  id: number;
  code: string;
  kind: VoucherKind;
  /** Every line of value, in mint order. Index = item identity (see VoucherItem). */
  items: VoucherItem[];
  batchId: string | null;
  batchLabel: string | null;
  issuedSource: string;
  issuedTo: { email?: string; phone?: string; name?: string } | null;
  expiresAt: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type VoucherEventType = "mint" | "send" | "scan" | "redeem" | "release" | "void";

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS vouchers (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'gamezone',
        -- JSON array of VoucherItem: a voucher is a list of independently
        -- redeemable lines, not one grant. Index in the array = item identity.
        items JSONB NOT NULL,
        batch_id TEXT,
        batch_label TEXT,
        issued_source TEXT NOT NULL DEFAULT 'admin',
        issued_to JSONB,
        expires_at TIMESTAMPTZ,
        voided_at TIMESTAMPTZ,
        voided_reason TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS vouchers_batch ON vouchers (batch_id)`;
    await q`
      CREATE TABLE IF NOT EXISTS voucher_events (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        event TEXT NOT NULL,
        detail JSONB,
        actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS voucher_events_code ON voucher_events (code, created_at)`;
  })();
  return schemaReady;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function decode(r: any): VoucherRow {
  const raw = typeof r.items === "string" ? JSON.parse(r.items) : r.items;
  const items: VoucherItem[] = Array.isArray(raw) ? raw : [];
  return {
    id: Number(r.id),
    code: String(r.code),
    kind: String(r.kind) as VoucherKind,
    items,
    batchId: r.batch_id ?? null,
    batchLabel: r.batch_label ?? null,
    issuedSource: String(r.issued_source ?? "admin"),
    issuedTo: r.issued_to ?? null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    voidedAt: r.voided_at ? String(r.voided_at) : null,
    voidedReason: r.voided_reason ?? null,
    createdBy: r.created_by ?? null,
    createdAt: String(r.created_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Append an audit line. Best-effort: never fail a redemption over a log row. */
export async function logVoucherEvent(
  code: string,
  event: VoucherEventType,
  detail?: unknown,
  actor?: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO voucher_events (code, event, detail, actor)
      VALUES (${code}, ${event}, ${detail ? JSON.stringify(detail) : null}, ${actor ?? null})
    `;
  } catch (err) {
    console.error("[vouchers] event log failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Insert one minted voucher. Returns false if the code already existed — the
 * caller retries with a fresh code (a CSPRNG collision at 30^8 is vanishingly
 * unlikely, but "vanishingly" is not "never" and a silent overwrite would
 * re-point someone else's live voucher).
 */
export async function insertVoucher(args: {
  code: string;
  kind: VoucherKind;
  items: VoucherItem[];
  batchId: string | null;
  batchLabel: string | null;
  issuedSource: string;
  issuedTo: VoucherRow["issuedTo"];
  expiresAt: string | null;
  createdBy: string | null;
}): Promise<boolean> {
  if (!isDbConfigured()) throw new Error("vouchers: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO vouchers
      (code, kind, items, batch_id, batch_label, issued_source, issued_to,
       expires_at, created_by)
    VALUES
      (${args.code}, ${args.kind}, ${JSON.stringify(args.items)}, ${args.batchId},
       ${args.batchLabel}, ${args.issuedSource}, ${args.issuedTo ? JSON.stringify(args.issuedTo) : null},
       ${args.expiresAt}, ${args.createdBy})
    ON CONFLICT (code) DO NOTHING
    RETURNING id
  `) as unknown[];
  return rows.length > 0;
}

export async function getVoucher(code: string): Promise<VoucherRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`SELECT * FROM vouchers WHERE code = ${code} LIMIT 1`) as unknown[];
  return rows.length > 0 ? decode(rows[0]) : null;
}

export async function listVoucherBatch(batchId: string): Promise<VoucherRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM vouchers WHERE batch_id = ${batchId} ORDER BY id ASC
  `) as unknown[];
  return rows.map(decode);
}

/** Void an unspent voucher (misprint, wrong recipient, fraud). Idempotent. */
export async function voidVoucher(code: string, reason: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE vouchers SET voided_at = NOW(), voided_reason = ${reason}
    WHERE code = ${code} AND voided_at IS NULL
  `;
}

/** Record who a voucher was sent to (email/SMS delivery). */
export async function markVoucherSent(
  code: string,
  to: { email?: string; phone?: string; name?: string },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`UPDATE vouchers SET issued_to = ${JSON.stringify(to)} WHERE code = ${code}`;
}
