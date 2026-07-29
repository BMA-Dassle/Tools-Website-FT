/**
 * FastTrax-license grant obligations (persist-first doctrine) — the license twin
 * of race_pack_purchases (data/race-pack-purchases-db.ts).
 *
 * When a NEW / unlicensed racer buys a race pack, a $4.99 FastTrax License is
 * added to the same charge and must be REGISTERED on their BMI account (sold via
 * booking/sell 43473520 so BMI attaches the "License Fee" membership). Like a
 * pack credit, that registration is a GRANT OBLIGATION: durable in OUR DB before
 * any money moves, so a crash / BMI blip between charge and registration is
 * always recoverable from this table (status = 'register-failed' + last_error).
 *
 * person_id is a raw BMI id string — NEVER Number() it (BMI ID precision rule).
 *
 * source_key groups a purchase's obligations so a retried finalize is idempotent:
 *   standalone kiosk → the pack purchaseKey (`sp-…`)
 *   web race-packs    → the pack billId (`pack-…`)
 */
import { sql, isDbConfigured } from "@/lib/db";

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS race_license_grants (
      source_key      TEXT NOT NULL,
      person_id       TEXT NOT NULL,
      member_name     TEXT,
      email           TEXT,
      phone           TEXT,
      surface         TEXT NOT NULL,
      price_cents     INTEGER NOT NULL DEFAULT 499,
      status          TEXT NOT NULL DEFAULT 'pending',
      bmi_bill_id     TEXT,
      square_ref      TEXT,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_key, person_id)
    )
  `;
  ensured = true;
}

export interface LicenseObligationInput {
  /** Raw BMI person id string — NEVER Number() it. */
  personId: string;
  memberName: string;
  email?: string | null;
  phone?: string | null;
  priceCents: number;
}

export interface LicenseObligationRow {
  personId: string;
  memberName: string | null;
  email: string | null;
  phone: string | null;
  priceCents: number;
  status: string;
}

/** Upsert license obligations BEFORE the charge (idempotent on
 *  (source_key, person_id)). Throws when the DB is down: we must NOT charge on
 *  an unpersisted grant obligation. */
export async function upsertLicenseObligations(
  sourceKey: string,
  surface: "standalone" | "web",
  obligations: LicenseObligationInput[],
): Promise<void> {
  if (obligations.length === 0) return;
  if (!isDbConfigured()) throw new Error("DB not configured — cannot persist license obligation");
  await ensureTable();
  const q = sql();
  for (const o of obligations) {
    await q`
      INSERT INTO race_license_grants
        (source_key, person_id, member_name, email, phone, surface, price_cents)
      VALUES
        (${sourceKey}, ${o.personId}, ${o.memberName}, ${o.email ?? null}, ${o.phone ?? null}, ${surface}, ${o.priceCents})
      ON CONFLICT (source_key, person_id) DO UPDATE SET
        member_name = EXCLUDED.member_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        surface = EXCLUDED.surface,
        price_cents = EXCLUDED.price_cents,
        updated_at = NOW()
    `;
  }
}

/** Re-read a purchase's license obligations — server-authoritative at finalize,
 *  never trusted from the client. */
export async function getLicenseObligations(sourceKey: string): Promise<LicenseObligationRow[]> {
  if (!isDbConfigured()) return [];
  await ensureTable();
  const q = sql();
  const rows = (await q`
    SELECT person_id, member_name, email, phone, price_cents, status
    FROM race_license_grants
    WHERE source_key = ${sourceKey}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    personId: String(r.person_id),
    memberName: r.member_name == null ? null : String(r.member_name),
    email: r.email == null ? null : String(r.email),
    phone: r.phone == null ? null : String(r.phone),
    priceCents: Number(r.price_cents),
    status: String(r.status),
  }));
}

/** Registration succeeded — BMI sold + confirmed the license bill. */
export async function markLicenseRegistered(
  sourceKey: string,
  personId: string,
  bmiBillId: string,
  squareRef?: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE race_license_grants
    SET status = 'registered', bmi_bill_id = ${bmiBillId},
        square_ref = COALESCE(${squareRef ?? null}, square_ref),
        last_error = NULL, updated_at = NOW()
    WHERE source_key = ${sourceKey} AND person_id = ${personId}
  `;
}

/** Registration failed AFTER the money was captured — the row is the reconcile
 *  target (staff sells the license at the desk; the guest already paid once). */
export async function markLicenseRegisterFailed(
  sourceKey: string,
  personId: string,
  error: string,
  squareRef?: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureTable();
  const q = sql();
  await q`
    UPDATE race_license_grants
    SET status = 'register-failed', last_error = ${error.slice(0, 500)},
        square_ref = COALESCE(${squareRef ?? null}, square_ref),
        updated_at = NOW()
    WHERE source_key = ${sourceKey} AND person_id = ${personId}
  `;
}
