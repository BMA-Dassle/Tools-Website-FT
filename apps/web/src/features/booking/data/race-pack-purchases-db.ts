/**
 * Kiosk race-pack purchases (persist-first doctrine): every pack a guest pays
 * for is a GRANT OBLIGATION — durable in OUR DB before any money moves, so a
 * crash between charge and grant is always recoverable from this table (+ the
 * deposit retry sweep, which carries the actual grant retries).
 *
 * person_id is a raw BMI id string — NEVER Number() it (BMI ID precision rule).
 */
import { sql, isDbConfigured } from "@/lib/db";
import type { ResolvedKioskPack } from "../service/race-pack-kiosk";

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS race_pack_purchases (
      purchase_key    TEXT NOT NULL,
      person_id       TEXT NOT NULL,
      pack_slug       TEXT NOT NULL,
      member_name     TEXT,
      pack_label      TEXT,
      deposit_kind_id TEXT NOT NULL,
      race_count      INTEGER NOT NULL,
      price_cents     INTEGER NOT NULL,
      surface         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      square_order_id TEXT,
      square_payment_id TEXT,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (purchase_key, person_id, pack_slug)
    )
  `;
  ensured = true;
}

/** Upsert intents at PREPARE (idempotent on the purchase key — a retried
 *  prepare re-writes the same rows). Throws when the DB is down: we must NOT
 *  proceed to charge on an unpersisted grant obligation. */
export async function upsertPackPurchases(args: {
  purchaseKey: string;
  surface: "booking" | "standalone";
  packs: ResolvedKioskPack[];
}): Promise<void> {
  if (args.packs.length === 0) return;
  if (!isDbConfigured()) throw new Error("DB not configured — cannot persist race-pack purchase");
  await ensureTable();
  const q = sql();
  for (const p of args.packs) {
    await q`
      INSERT INTO race_pack_purchases
        (purchase_key, person_id, pack_slug, member_name, pack_label, deposit_kind_id, race_count, price_cents, surface)
      VALUES
        (${args.purchaseKey}, ${p.personId}, ${p.slug}, ${p.memberName}, ${p.label}, ${p.pack.depositKindId}, ${p.pack.raceCount}, ${p.priceCents}, ${args.surface})
      ON CONFLICT (purchase_key, person_id, pack_slug) DO UPDATE SET
        member_name = EXCLUDED.member_name,
        deposit_kind_id = EXCLUDED.deposit_kind_id,
        race_count = EXCLUDED.race_count,
        price_cents = EXCLUDED.price_cents,
        surface = EXCLUDED.surface,
        updated_at = NOW()
    `;
  }
}

/** Stamp the Square order id at PREPARE (standalone rail) so finalize verifies
 *  the payment against OUR stored order — never a client-supplied id. */
export async function stampPackOrder(purchaseKey: string, squareOrderId: string): Promise<void> {
  if (!isDbConfigured()) throw new Error("DB not configured");
  await ensureTable();
  const q = sql();
  await q`
    UPDATE race_pack_purchases
    SET square_order_id = ${squareOrderId}, updated_at = NOW()
    WHERE purchase_key = ${purchaseKey}
  `;
}

export interface PackPurchaseRow {
  personId: string;
  packSlug: string;
  memberName: string | null;
  packLabel: string | null;
  depositKindId: string;
  raceCount: number;
  priceCents: number;
  status: string;
  squareOrderId: string | null;
}

/** Re-read the persisted rows — amounts/assignees are server-authoritative at
 *  finalize, never trusted from the client (getTxn pattern). */
export async function getPackPurchases(purchaseKey: string): Promise<PackPurchaseRow[]> {
  if (!isDbConfigured()) return [];
  await ensureTable();
  const q = sql();
  const rows = (await q`
    SELECT person_id, pack_slug, member_name, pack_label, deposit_kind_id,
           race_count, price_cents, status, square_order_id
    FROM race_pack_purchases
    WHERE purchase_key = ${purchaseKey}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    personId: String(r.person_id),
    packSlug: String(r.pack_slug),
    memberName: r.member_name == null ? null : String(r.member_name),
    packLabel: r.pack_label == null ? null : String(r.pack_label),
    depositKindId: String(r.deposit_kind_id),
    raceCount: Number(r.race_count),
    priceCents: Number(r.price_cents),
    status: String(r.status),
    squareOrderId: r.square_order_id == null ? null : String(r.square_order_id),
  }));
}

export async function markPackCharged(
  purchaseKey: string,
  ids: { squareOrderId?: string | null; squarePaymentId?: string | null },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE race_pack_purchases
    SET status = CASE WHEN status = 'pending' THEN 'charged' ELSE status END,
        square_order_id = COALESCE(${ids.squareOrderId ?? null}, square_order_id),
        square_payment_id = COALESCE(${ids.squarePaymentId ?? null}, square_payment_id),
        updated_at = NOW()
    WHERE purchase_key = ${purchaseKey}
  `;
}

export async function markPackGranted(
  purchaseKey: string,
  personId: string,
  packSlug: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE race_pack_purchases
    SET status = 'granted', last_error = NULL, updated_at = NOW()
    WHERE purchase_key = ${purchaseKey} AND person_id = ${personId} AND pack_slug = ${packSlug}
  `;
}

/** Grant attempt failed — the deposit retry sweep owns the retries; this row
 *  keeps the audit trail (and the reconcile target if the sweep ever misses). */
export async function markPackGrantFailed(
  purchaseKey: string,
  personId: string,
  packSlug: string,
  error: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE race_pack_purchases
    SET status = 'grant-failed', last_error = ${error.slice(0, 500)}, updated_at = NOW()
    WHERE purchase_key = ${purchaseKey} AND person_id = ${personId} AND pack_slug = ${packSlug}
  `;
}
