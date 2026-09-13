/**
 * `crm_contacts` — a person we can reach (brief §3.8). `bmi_person_id` is TEXT
 * (17-digit Office ids). DDL from PR1; B1 adds the upsert the BMI mirror links
 * hosts through and the account's contact list; B3 adds the lead-side writers.
 *
 * MATCH ORDER for a mirrored host: `bmi_person_id` (exact) → `phone_e164` →
 * `email_key`; a new row otherwise. A match by phone or email BACKFILLS the
 * person id it lacked, so the next run matches on the id. Names and the
 * account link are filled in only where the row is empty — a rep's manual
 * edit is never overwritten by a sync.
 *
 * B3's `upsertContact` is the CAPTURE side of the same table: a lead arrives
 * with a phone and an email and no person id, so it matches phone → email and
 * adds only what the capture brings. `patchContact` is the one writer that may
 * clear a field, because a rep typed the correction by hand.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CrmContact } from "../../core/types";
import { ensureAccountsSchema } from "./accounts-db";

let schemaReady: Promise<void> | null = null;

export function ensureContactsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureAccountsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_contacts (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT REFERENCES crm_accounts(id),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL DEFAULT '',
        phone_e164 TEXT,
        email TEXT,
        email_key TEXT,
        bmi_person_id TEXT,
        prefers TEXT CHECK (prefers IN ('text','call','email')),
        meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_contacts_phone ON crm_contacts (phone_e164)`;
    await q`CREATE INDEX IF NOT EXISTS crm_contacts_email ON crm_contacts (email_key)`;
    // B1: the mirror matches on the Office person id first.
    await q`CREATE INDEX IF NOT EXISTS crm_contacts_bmi_person ON crm_contacts (bmi_person_id)`;
    await q`CREATE INDEX IF NOT EXISTS crm_contacts_account ON crm_contacts (account_id)`;
  })();
  return schemaReady;
}

export interface ContactRowRaw {
  id: string;
  account_id: string | null;
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  email: string | null;
  email_key: string | null;
  bmi_person_id: string | null;
  prefers: string | null;
  meta: unknown;
  created_at: string;
  updated_at: string;
}

const PREFERS = new Set(["text", "call", "email"]);

export function mapContactRow(r: ContactRowRaw): CrmContact {
  return {
    id: String(r.id),
    accountId: r.account_id === null || r.account_id === undefined ? null : String(r.account_id),
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    phoneE164: r.phone_e164 ?? null,
    email: r.email ?? null,
    bmiPersonId: r.bmi_person_id ?? null,
    prefers: r.prefers && PREFERS.has(r.prefers) ? (r.prefers as CrmContact["prefers"]) : null,
    meta:
      r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)
        ? (r.meta as Record<string, unknown>)
        : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `
  c.id::text AS id, c.account_id::text AS account_id, c.first_name, c.last_name, c.phone_e164, c.email, c.email_key,
  c.bmi_person_id, c.prefers, c.meta, c.created_at::text AS created_at, c.updated_at::text AS updated_at
`;

export function emailKeyOf(email: string | null | undefined): string | null {
  const k = (email ?? "").trim().toLowerCase();
  return k ? k : null;
}

export interface ContactUpsertInput {
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  emailKey: string | null;
  bmiPersonId: string | null;
  accountId: string | null;
}

/**
 * Find-or-create a host from a mirrored Office person. Returns the row and
 * whether it was created. Never throws for a person with nothing to match on
 * beyond a name — that still gets a row keyed by the person id.
 */
export async function upsertContactFromBmi(
  input: ContactUpsertInput,
): Promise<{ contact: CrmContact; created: boolean }> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureContactsSchema();
  const q = sql();
  const found = (await q.query(
    `SELECT ${COLUMNS},
            CASE WHEN $1::text IS NOT NULL AND c.bmi_person_id = $1 THEN 0
                 WHEN $2::text IS NOT NULL AND c.phone_e164 = $2 THEN 1
                 WHEN $3::text IS NOT NULL AND c.email_key = $3 THEN 2
                 ELSE 9 END AS rank
       FROM crm_contacts c
      WHERE ($1::text IS NOT NULL AND c.bmi_person_id = $1)
         OR ($2::text IS NOT NULL AND c.phone_e164 = $2)
         OR ($3::text IS NOT NULL AND c.email_key = $3)
      ORDER BY rank ASC, c.id ASC
      LIMIT 1`,
    [input.bmiPersonId, input.phoneE164, input.emailKey],
  )) as (ContactRowRaw & { rank: number })[];

  if (found[0]) {
    const rows = (await q.query(
      `UPDATE crm_contacts c
          SET bmi_person_id = COALESCE(c.bmi_person_id, $2),
              phone_e164 = COALESCE(c.phone_e164, $3),
              email = COALESCE(c.email, $4),
              email_key = COALESCE(c.email_key, $5),
              first_name = CASE WHEN c.first_name = '' THEN $6 ELSE c.first_name END,
              last_name = CASE WHEN c.last_name = '' THEN $7 ELSE c.last_name END,
              account_id = COALESCE(c.account_id, $8::bigint),
              updated_at = NOW()
        WHERE c.id = $1::bigint
        RETURNING ${COLUMNS}`,
      [
        found[0].id,
        input.bmiPersonId,
        input.phoneE164,
        input.email,
        input.emailKey,
        input.firstName,
        input.lastName,
        input.accountId,
      ],
    )) as ContactRowRaw[];
    return { contact: mapContactRow(rows[0] ?? found[0]), created: false };
  }

  const rows = (await q.query(
    `INSERT INTO crm_contacts AS c (account_id, first_name, last_name, phone_e164, email, email_key, bmi_person_id, meta)
     VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.accountId,
      input.firstName,
      input.lastName,
      input.phoneE164,
      input.email,
      input.emailKey,
      input.bmiPersonId,
      JSON.stringify({ source: "bmi-mirror" }),
    ],
  )) as ContactRowRaw[];
  if (!rows[0]) throw new Error("crm_contacts: insert returned no row");
  return { contact: mapContactRow(rows[0]), created: true };
}

export async function listContactsForAccount(accountId: string, limit = 50): Promise<CrmContact[]> {
  if (!isDbConfigured() || !/^\d+$/.test(accountId)) return [];
  await ensureContactsSchema();
  const q = sql();
  const rows = (await q.query(
    // Both the contacts filed UNDER the account and the hosts of its mirrored
    // events: a person who was first seen booking privately keeps their own
    // household on `crm_contacts.account_id` (a sync never overwrites that),
    // yet they are still the contact for the company's events — and the
    // prototype's Contacts tile means "who books for this account".
    `SELECT ${COLUMNS} FROM crm_contacts c
      WHERE c.account_id = $1::bigint
         OR c.id IN (SELECT p.contact_id FROM crm_bmi_projects p
                      WHERE p.account_id = $1::bigint AND p.contact_id IS NOT NULL)
      ORDER BY c.updated_at DESC, c.id ASC
      LIMIT $2`,
    [accountId, Math.min(Math.max(limit, 1), 200)],
  )) as ContactRowRaw[];
  return rows.map(mapContactRow);
}

export interface ContactUpsert {
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  accountId?: string | null;
  prefers?: "text" | "call" | "email" | null;
  bmiPersonId?: string | null;
}

/** Find by phone, else by email; update what the capture adds; else insert. */
export async function upsertContact(input: ContactUpsert): Promise<CrmContact> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureContactsSchema();
  const q = sql();
  const emailKey = emailKeyOf(input.email);
  const existing = (await q.query(
    `SELECT ${COLUMNS} FROM crm_contacts c
      WHERE ($1::text IS NOT NULL AND c.phone_e164 = $1)
         OR ($2::text IS NOT NULL AND c.email_key = $2)
      ORDER BY (c.phone_e164 = $1) DESC NULLS LAST, c.id ASC
      LIMIT 1`,
    [input.phoneE164, emailKey],
  )) as ContactRowRaw[];

  if (existing[0]) {
    const rows = (await q.query(
      `UPDATE crm_contacts c
          SET first_name = CASE WHEN c.first_name = '' THEN $2 ELSE c.first_name END,
              last_name = CASE WHEN c.last_name = '' THEN $3 ELSE c.last_name END,
              phone_e164 = COALESCE(c.phone_e164, $4),
              email = COALESCE(c.email, $5),
              email_key = COALESCE(c.email_key, $6),
              account_id = COALESCE($7::bigint, c.account_id),
              prefers = COALESCE($8, c.prefers),
              bmi_person_id = COALESCE($9, c.bmi_person_id),
              updated_at = NOW()
        WHERE c.id = $1::bigint
        RETURNING ${COLUMNS}`,
      [
        existing[0].id,
        input.firstName,
        input.lastName,
        input.phoneE164,
        input.email,
        emailKey,
        input.accountId ?? null,
        input.prefers ?? null,
        input.bmiPersonId ?? null,
      ],
    )) as ContactRowRaw[];
    return mapContactRow(rows[0]!);
  }

  const rows = (await q.query(
    `INSERT INTO crm_contacts AS c (first_name, last_name, phone_e164, email, email_key, account_id, prefers, bmi_person_id)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.firstName,
      input.lastName,
      input.phoneE164,
      input.email,
      emailKey,
      input.accountId ?? null,
      input.prefers ?? null,
      input.bmiPersonId ?? null,
    ],
  )) as ContactRowRaw[];
  if (!rows[0]) throw new Error("crm_contacts: insert returned no row");
  return mapContactRow(rows[0]);
}

export async function getContact(id: string): Promise<CrmContact | null> {
  if (!isDbConfigured() || !/^\d+$/.test(id)) return null;
  await ensureContactsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_contacts c WHERE c.id = $1::bigint`, [
    id,
  ])) as ContactRowRaw[];
  return rows[0] ? mapContactRow(rows[0]) : null;
}

export interface ContactPatch {
  firstName?: string;
  lastName?: string;
  phoneE164?: string | null;
  email?: string | null;
  prefers?: "text" | "call" | "email" | null;
  bmiPersonId?: string | null;
}

/** Explicit edits from the deal (a rep correcting a number); `undefined` leaves a field alone. */
export async function patchContact(id: string, patch: ContactPatch): Promise<CrmContact | null> {
  if (!isDbConfigured() || !/^\d+$/.test(id)) return null;
  await ensureContactsSchema();
  const q = sql();
  const email = patch.email;
  const rows = (await q.query(
    `UPDATE crm_contacts c
        SET first_name = COALESCE($2, c.first_name),
            last_name = COALESCE($3, c.last_name),
            phone_e164 = CASE WHEN $4::boolean THEN $5 ELSE c.phone_e164 END,
            email = CASE WHEN $6::boolean THEN $7 ELSE c.email END,
            email_key = CASE WHEN $6::boolean THEN $8 ELSE c.email_key END,
            prefers = CASE WHEN $9::boolean THEN $10 ELSE c.prefers END,
            bmi_person_id = COALESCE($11, c.bmi_person_id),
            updated_at = NOW()
      WHERE c.id = $1::bigint
      RETURNING ${COLUMNS}`,
    [
      id,
      patch.firstName ?? null,
      patch.lastName ?? null,
      patch.phoneE164 !== undefined,
      patch.phoneE164 ?? null,
      email !== undefined,
      email ?? null,
      email !== undefined ? emailKeyOf(email) : null,
      patch.prefers !== undefined,
      patch.prefers ?? null,
      patch.bmiPersonId ?? null,
    ],
  )) as ContactRowRaw[];
  return rows[0] ? mapContactRow(rows[0]) : null;
}
