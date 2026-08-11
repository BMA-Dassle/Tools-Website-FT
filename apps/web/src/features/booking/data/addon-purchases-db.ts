/**
 * Booking add-on purchases (persist-first doctrine): every retail add-on a
 * guest pays for (v1: replacement headsock) is a GRANT OBLIGATION — durable
 * in OUR DB before any money moves, so a crash between charge and grant is
 * always recoverable from this table (+ the deposit retry sweep, which
 * carries the actual grant retries once a person id exists).
 *
 * Unlike race_pack_purchases, `person_id` is NULLABLE: a brand-new web racer
 * has no BMI person at reserve time (bmi-register skips members without
 * bmiPersonId). Those rows park as `awaiting-person` — the durable recovery
 * handle. NO automatic resolver exists yet: the admin check-in scan only
 * carries (personId, sessionId) with no reservation/purchase-key linkage, so
 * a v1 resolver would have to name-match (fragile). It ships as a fast-follow
 * once web new-racer person creation lands (the same gap that leaves those
 * racers off the grid today — see tasks: web race first-timer investigation).
 * Until then: `SELECT * FROM addon_purchases WHERE status='awaiting-person'`
 * is the ops worklist; grant manually via Pandora addDeposit.
 *
 * person_id is a raw BMI id string — NEVER Number() it (BMI ID precision rule).
 */
import { sql, isDbConfigured } from "@/lib/db";

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS addon_purchases (
      purchase_key    TEXT NOT NULL,
      member_id       TEXT NOT NULL,
      addon_slug      TEXT NOT NULL,
      person_id       TEXT,
      member_name     TEXT,
      deposit_kind_id TEXT,
      grant_amount    INTEGER NOT NULL DEFAULT 0,
      price_cents     INTEGER NOT NULL,
      surface         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      square_order_id TEXT,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (purchase_key, member_id, addon_slug)
    )
  `;
  ensured = true;
}

export interface AddonPurchaseIntent {
  /** Session party member id — the ledger PK leg (stable even with no person). */
  memberId: string;
  addonSlug: string;
  /** Raw BMI person id string, when the racer has one at reserve time. */
  personId: string | null;
  memberName: string | null;
  /** Pandora fulfillment (from the catalog `grant`); null = line-item only. */
  depositKindId: string | null;
  grantAmount: number;
  priceCents: number;
}

/** Upsert intents BEFORE the charge (idempotent on the purchase key — a
 *  retried reserve re-writes the same rows). Throws when the DB is down: we
 *  must NOT proceed to charge on an unpersisted grant obligation. */
export async function upsertAddonPurchases(args: {
  purchaseKey: string;
  /** Which flow sold it — a ledger label ("booking-web" | "booking-kiosk"). */
  surface: string;
  intents: AddonPurchaseIntent[];
}): Promise<void> {
  if (args.intents.length === 0) return;
  if (!isDbConfigured()) throw new Error("DB not configured — cannot persist add-on purchase");
  await ensureTable();
  const q = sql();
  for (const it of args.intents) {
    await q`
      INSERT INTO addon_purchases
        (purchase_key, member_id, addon_slug, person_id, member_name, deposit_kind_id, grant_amount, price_cents, surface)
      VALUES
        (${args.purchaseKey}, ${it.memberId}, ${it.addonSlug}, ${it.personId}, ${it.memberName}, ${it.depositKindId}, ${it.grantAmount}, ${it.priceCents}, ${args.surface})
      ON CONFLICT (purchase_key, member_id, addon_slug) DO UPDATE SET
        person_id = COALESCE(EXCLUDED.person_id, addon_purchases.person_id),
        member_name = EXCLUDED.member_name,
        deposit_kind_id = EXCLUDED.deposit_kind_id,
        grant_amount = EXCLUDED.grant_amount,
        price_cents = EXCLUDED.price_cents,
        surface = EXCLUDED.surface,
        updated_at = NOW()
    `;
  }
}

export async function markAddonGranted(
  purchaseKey: string,
  memberId: string,
  addonSlug: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE addon_purchases
    SET status = 'granted', last_error = NULL, updated_at = NOW()
    WHERE purchase_key = ${purchaseKey} AND member_id = ${memberId} AND addon_slug = ${addonSlug}
  `;
}

/** Grant attempt failed — the deposit retry sweep owns the retries; this row
 *  keeps the audit trail (and the reconcile target if the sweep ever misses). */
export async function markAddonGrantFailed(
  purchaseKey: string,
  memberId: string,
  addonSlug: string,
  error: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE addon_purchases
    SET status = 'grant-failed', last_error = ${error.slice(0, 500)}, updated_at = NOW()
    WHERE purchase_key = ${purchaseKey} AND member_id = ${memberId} AND addon_slug = ${addonSlug}
  `;
}

/** No person id yet (brand-new racer) — parked until check-in resolves one. */
export async function markAddonAwaitingPerson(
  purchaseKey: string,
  memberId: string,
  addonSlug: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE addon_purchases
    SET status = 'awaiting-person', updated_at = NOW()
    WHERE purchase_key = ${purchaseKey} AND member_id = ${memberId} AND addon_slug = ${addonSlug}
  `;
}

export interface AwaitingPersonAddonRow {
  purchaseKey: string;
  memberId: string;
  addonSlug: string;
  memberName: string | null;
  depositKindId: string | null;
  grantAmount: number;
}

/** Awaiting-person rows for a booking's purchase key — the check-in resolver
 *  grants these once it has resolved the guest's person id. */
export async function getAwaitingPersonAddons(
  purchaseKey: string,
): Promise<AwaitingPersonAddonRow[]> {
  if (!isDbConfigured()) return [];
  await ensureTable();
  const q = sql();
  const rows = (await q`
    SELECT purchase_key, member_id, addon_slug, member_name, deposit_kind_id, grant_amount
    FROM addon_purchases
    WHERE purchase_key = ${purchaseKey} AND status = 'awaiting-person'
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    purchaseKey: String(r.purchase_key),
    memberId: String(r.member_id),
    addonSlug: String(r.addon_slug),
    memberName: r.member_name == null ? null : String(r.member_name),
    depositKindId: r.deposit_kind_id == null ? null : String(r.deposit_kind_id),
    grantAmount: Number(r.grant_amount),
  }));
}

/** Stamp the resolved person id on an awaiting-person row (audit trail —
 *  the grant marks it `granted` right after). */
export async function stampAddonPerson(
  purchaseKey: string,
  memberId: string,
  addonSlug: string,
  personId: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE addon_purchases
    SET person_id = ${personId}, updated_at = NOW()
    WHERE purchase_key = ${purchaseKey} AND member_id = ${memberId} AND addon_slug = ${addonSlug}
  `;
}
