/**
 * Employee perks — the Neon data layer. Two tables, next to the discount-code
 * ledger they are the sibling of:
 *
 *   employee_bmi_links         WHICH BMI person a 7shifts user is. Written only
 *                              after a one-time code passed AND the name rule
 *                              matched (programs/employee.ts). Read by the
 *                              code-free recognition path.
 *   employee_perk_redemptions  One row per perk unit actually charged: a free
 *                              race (per heat), a 50% line (per Square order),
 *                              a doubled Game Zone card (per card). The weekly
 *                              free-race allowance is `SUM(qty)` of the
 *                              `free-race` rows for (user, week). Idempotent on
 *                              (perk, external_ref, unit_ref) so a retried
 *                              reserve never double-counts.
 *
 * Keyed on the 7SHIFTS USER ID, never a BMI person: employees can hold several
 * BMI records (the duplicate-registration problem), and a per-person deposit
 * would fragment the weekly count across them.
 *
 * BMI person ids are TEXT and travel as raw strings — never `Number()` them.
 */

import { sql, isDbConfigured } from "@ft/db";
import type { EmployeePerkKind } from "./employee";

export interface EmployeeLinkRow {
  id: number;
  userId: number;
  bmiPersonId: string;
  clientKey: string | null;
  matchedBy: string;
  linkedAt: string;
  lastSeenAt: string;
}

export interface PerkRedemptionInput {
  userId: number;
  perk: EmployeePerkKind;
  weekKey: string;
  /** Square day-of order id (booking) or the card ledger txn id (Game Zone). */
  externalRef: string;
  /** Distinguishes several units under one ref — a heat id, a card txn. "" for one-per-ref. */
  unitRef?: string;
  qty?: number;
  amountOffCents?: number;
  source?: string | null;
  detail?: Record<string, unknown> | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    if (!isDbConfigured()) return;
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS employee_bmi_links (
        id                    BIGSERIAL PRIMARY KEY,
        seven_shifts_user_id  INTEGER NOT NULL,
        bmi_person_id         TEXT    NOT NULL,
        client_key            TEXT,
        matched_by            TEXT    NOT NULL,
        linked_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unlinked_at           TIMESTAMPTZ
      )
    `;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS ebl_user_person ON employee_bmi_links (seven_shifts_user_id, bmi_person_id)`;
    await q`CREATE INDEX IF NOT EXISTS ebl_person ON employee_bmi_links (bmi_person_id) WHERE unlinked_at IS NULL`;

    await q`
      CREATE TABLE IF NOT EXISTS employee_perk_redemptions (
        id                    BIGSERIAL PRIMARY KEY,
        seven_shifts_user_id  INTEGER NOT NULL,
        perk                  TEXT    NOT NULL,
        week_key              TEXT    NOT NULL,
        external_ref          TEXT    NOT NULL,
        unit_ref              TEXT    NOT NULL DEFAULT '',
        qty                   INTEGER NOT NULL DEFAULT 1,
        amount_off_cents      INTEGER NOT NULL DEFAULT 0,
        source                TEXT,
        detail                JSONB,
        redeemed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        refunded_at           TIMESTAMPTZ
      )
    `;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS epr_unit ON employee_perk_redemptions (perk, external_ref, unit_ref)`;
    await q`CREATE INDEX IF NOT EXISTS epr_user_week ON employee_perk_redemptions (seven_shifts_user_id, perk, week_key)`;
  })();
  return schemaReady;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function decodeLink(r: Record<string, unknown>): EmployeeLinkRow {
  return {
    id: Number(r.id),
    userId: Number(r.seven_shifts_user_id),
    bmiPersonId: String(r.bmi_person_id),
    clientKey: r.client_key == null ? null : String(r.client_key),
    matchedBy: String(r.matched_by),
    linkedAt: iso(r.linked_at),
    lastSeenAt: iso(r.last_seen_at),
  };
}

/** Persist (or refresh) a link. Re-linking a previously unlinked pair re-activates it. */
export async function upsertEmployeeLink(input: {
  userId: number;
  bmiPersonId: string;
  clientKey?: string | null;
  matchedBy: string;
}): Promise<EmployeeLinkRow | null> {
  await ensureSchema();
  if (!isDbConfigured()) return null;
  const q = sql();
  const rows = (await q`
    INSERT INTO employee_bmi_links (seven_shifts_user_id, bmi_person_id, client_key, matched_by)
    VALUES (${input.userId}, ${input.bmiPersonId}, ${input.clientKey ?? null}, ${input.matchedBy})
    ON CONFLICT (seven_shifts_user_id, bmi_person_id) DO UPDATE SET
      last_seen_at = NOW(),
      unlinked_at = NULL,
      matched_by = EXCLUDED.matched_by,
      client_key = COALESCE(EXCLUDED.client_key, employee_bmi_links.client_key)
    RETURNING *
  `) as Record<string, unknown>[];
  return rows[0] ? decodeLink(rows[0]) : null;
}

/** The live link for a BMI person, most recently seen first. Null = not an employee's record. */
export async function getEmployeeLinkForPerson(
  bmiPersonId: string,
): Promise<EmployeeLinkRow | null> {
  await ensureSchema();
  if (!isDbConfigured() || !bmiPersonId) return null;
  const q = sql();
  const rows = (await q`
    SELECT * FROM employee_bmi_links
    WHERE bmi_person_id = ${bmiPersonId} AND unlinked_at IS NULL
    ORDER BY last_seen_at DESC
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows[0] ? decodeLink(rows[0]) : null;
}

/** Every live link for a 7shifts user (an employee can hold several BMI records). */
export async function listEmployeeLinks(userId: number): Promise<EmployeeLinkRow[]> {
  await ensureSchema();
  if (!isDbConfigured()) return [];
  const q = sql();
  const rows = (await q`
    SELECT * FROM employee_bmi_links
    WHERE seven_shifts_user_id = ${userId} AND unlinked_at IS NULL
    ORDER BY last_seen_at DESC
  `) as Record<string, unknown>[];
  return rows.map(decodeLink);
}

/** Touch `last_seen_at` on a recognised link (fire-and-forget by callers). */
export async function touchEmployeeLink(userId: number, bmiPersonId: string): Promise<void> {
  await ensureSchema();
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    UPDATE employee_bmi_links SET last_seen_at = NOW()
    WHERE seven_shifts_user_id = ${userId} AND bmi_person_id = ${bmiPersonId} AND unlinked_at IS NULL
  `;
}

/** Free single races already redeemed (and not refunded) this pay week. */
export async function countFreeRacesUsed(userId: number, weekKey: string): Promise<number> {
  await ensureSchema();
  if (!isDbConfigured()) return 0;
  const q = sql();
  const rows = (await q`
    SELECT COALESCE(SUM(qty), 0)::int AS used
    FROM employee_perk_redemptions
    WHERE seven_shifts_user_id = ${userId}
      AND perk = 'free-race'
      AND week_key = ${weekKey}
      AND refunded_at IS NULL
  `) as Array<{ used: number }>;
  return Number(rows[0]?.used ?? 0);
}

/**
 * Record perk units. Idempotent on (perk, external_ref, unit_ref): a retried
 * reserve re-sends the same rows and inserts nothing. Returns how many were new.
 */
export async function recordPerkRedemptions(rows: PerkRedemptionInput[]): Promise<number> {
  await ensureSchema();
  if (!isDbConfigured() || rows.length === 0) return 0;
  const q = sql();
  let inserted = 0;
  for (const r of rows) {
    const res = (await q`
      INSERT INTO employee_perk_redemptions
        (seven_shifts_user_id, perk, week_key, external_ref, unit_ref, qty, amount_off_cents, source, detail)
      VALUES (
        ${r.userId}, ${r.perk}, ${r.weekKey}, ${r.externalRef}, ${r.unitRef ?? ""},
        ${r.qty ?? 1}, ${r.amountOffCents ?? 0}, ${r.source ?? null},
        ${r.detail ? JSON.stringify(r.detail) : null}::jsonb
      )
      ON CONFLICT (perk, external_ref, unit_ref) DO NOTHING
      RETURNING id
    `) as Array<{ id: number }>;
    inserted += res.length;
  }
  return inserted;
}

/** Mark every unit under a ref refunded (cancellation). Idempotent. */
export async function refundPerkRedemptions(externalRef: string): Promise<number> {
  await ensureSchema();
  if (!isDbConfigured() || !externalRef) return 0;
  const q = sql();
  const rows = (await q`
    UPDATE employee_perk_redemptions SET refunded_at = NOW()
    WHERE external_ref = ${externalRef} AND refunded_at IS NULL
    RETURNING id
  `) as Array<{ id: number }>;
  return rows.length;
}
