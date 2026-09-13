/**
 * `crm_contacts` — a person we can reach (brief §3.8). `bmi_person_id` is TEXT
 * (17-digit Office ids). DDL is PR1's; B3 adds the upsert and readers.
 *
 * MATCHING. A contact is the same person when the E.164 phone matches, else
 * when the lowercased email matches. A match is UPDATED with whatever the new
 * capture adds (a name we did not have, an email, a preference) and never
 * loses a field it already had.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CrmContact } from "../../core/types";
import { ensureAccountsSchema } from "./accounts-db";
import { ISO } from "./sql";

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
    accountId: r.account_id ? String(r.account_id) : null,
    firstName: r.first_name,
    lastName: r.last_name ?? "",
    phoneE164: r.phone_e164 ?? null,
    email: r.email ?? null,
    bmiPersonId: r.bmi_person_id ?? null,
    prefers: PREFERS.has(r.prefers ?? "") ? (r.prefers as CrmContact["prefers"]) : null,
    meta:
      r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)
        ? (r.meta as Record<string, unknown>)
        : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `
  id::text AS id, account_id::text AS account_id, first_name, last_name, phone_e164, email,
  bmi_person_id, prefers, meta,
  ${ISO("created_at")} AS created_at, ${ISO("updated_at")} AS updated_at
`;

export function emailKeyOf(email: string | null | undefined): string | null {
  const k = (email ?? "").trim().toLowerCase();
  return k ? k : null;
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
    `SELECT ${COLUMNS} FROM crm_contacts
      WHERE ($1::text IS NOT NULL AND phone_e164 = $1)
         OR ($2::text IS NOT NULL AND email_key = $2)
      ORDER BY (phone_e164 = $1) DESC NULLS LAST, id ASC
      LIMIT 1`,
    [input.phoneE164, emailKey],
  )) as ContactRowRaw[];

  if (existing[0]) {
    const rows = (await q.query(
      `UPDATE crm_contacts
          SET first_name = CASE WHEN first_name = '' THEN $2 ELSE first_name END,
              last_name = CASE WHEN last_name = '' THEN $3 ELSE last_name END,
              phone_e164 = COALESCE(phone_e164, $4),
              email = COALESCE(email, $5),
              email_key = COALESCE(email_key, $6),
              account_id = COALESCE($7::bigint, account_id),
              prefers = COALESCE($8, prefers),
              bmi_person_id = COALESCE($9, bmi_person_id),
              updated_at = NOW()
        WHERE id = $1::bigint
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
    return mapContactRow(rows[0]);
  }

  const rows = (await q.query(
    `INSERT INTO crm_contacts (first_name, last_name, phone_e164, email, email_key, account_id, prefers, bmi_person_id)
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
  return mapContactRow(rows[0]);
}

export async function getContact(id: string): Promise<CrmContact | null> {
  if (!isDbConfigured()) return null;
  await ensureContactsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_contacts WHERE id = $1::bigint`, [
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
  if (!isDbConfigured()) return null;
  await ensureContactsSchema();
  const q = sql();
  const email = patch.email;
  const rows = (await q.query(
    `UPDATE crm_contacts
        SET first_name = COALESCE($2, first_name),
            last_name = COALESCE($3, last_name),
            phone_e164 = CASE WHEN $4::boolean THEN $5 ELSE phone_e164 END,
            email = CASE WHEN $6::boolean THEN $7 ELSE email END,
            email_key = CASE WHEN $6::boolean THEN $8 ELSE email_key END,
            prefers = CASE WHEN $9::boolean THEN $10 ELSE prefers END,
            bmi_person_id = COALESCE($11, bmi_person_id),
            updated_at = NOW()
      WHERE id = $1::bigint
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
