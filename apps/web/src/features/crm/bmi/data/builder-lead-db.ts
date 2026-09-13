/**
 * The lead the builder is quoting, and the ONE place its Office project id is
 * claimed.
 *
 * WHY IT LIVES HERE. C5's base is the availability branch, where the leads sub
 * is still DDL only — B3 is landing in parallel and owns every reader and
 * writer of `crm_leads`. Rather than block, the builder reads the columns it
 * needs through the DDL PR1 already shipped, exactly as C4 did for the
 * availability request bar (`availability/data/lead-lookup.ts`) and B2 did for
 * the volume query. It adds no column. The release step swaps these two
 * functions for B3's helpers the moment they exist.
 *
 * The schema import is LAZY on purpose: `leads → bmi` is the declared import
 * direction (docs/crm/bmi-mirror.md), so a static edge from this sub to the
 * leads barrel would close a runtime cycle between two eager re-export barrels
 * the moment B3 lands.
 */

import { isDbConfigured, sql } from "@ft/db";
import { CENTRES, isCentreCode } from "~/features/crm/core/centres";
import type { BuilderLead } from "../contracts";

let leadsSchemaReady: Promise<void> | null = null;

function ensureLeadsSchema(): Promise<void> {
  leadsSchemaReady ??= import("~/features/crm/leads")
    .then((m) => m.ensureLeadsSchema())
    .catch((err: unknown) => {
      // A rejected promise must not be memoised, or one transient Neon blip
      // 500s every builder read until the lambda recycles.
      leadsSchemaReady = null;
      throw err;
    });
  return leadsSchemaReady;
}

interface LeadRowRaw {
  id: string;
  public_id: string;
  centre: string;
  event_date: string | Date;
  event_time: string | null;
  guests: number | string;
  status_id: string;
  bmi_project_id: string | null;
  account_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_e164: string | null;
}

function ymdOf(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** `l.guest.company || first last` — the prototype's `leadTitle`. */
function titleOf(row: LeadRowRaw): string {
  const company = row.account_name?.trim();
  if (company) return company;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || row.public_id;
}

/** The lead, plus the contact details the host search needs. */
export interface BuilderLeadRow extends BuilderLead {
  /** The Neon BIGSERIAL, as text — the foreign key `crm_quote_lines` carries. */
  rowId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phoneE164: string | null;
}

/**
 * One lead by public id, or null when it does not exist.
 *
 * A null is an honest answer the screen renders as "that lead is not in the
 * CRM" — never a lead invented to fill the page, and never a write against a
 * project nobody asked for.
 */
export async function findLeadForBuilder(publicId: string): Promise<BuilderLeadRow | null> {
  if (!isDbConfigured()) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q`
    SELECT l.id::text AS id,
           l.public_id,
           l.centre,
           l.event_date,
           l.event_time::text AS event_time,
           l.guests,
           l.status_id,
           l.bmi_project_id,
           a.name AS account_name,
           c.first_name,
           c.last_name,
           c.email,
           c.phone_e164
      FROM crm_leads l
      LEFT JOIN crm_accounts a ON a.id = l.account_id
      LEFT JOIN crm_contacts c ON c.id = l.contact_id
     WHERE l.public_id = ${publicId}
       AND l.archived_at IS NULL
     LIMIT 1
  `) as LeadRowRaw[];

  const row = rows[0];
  if (!row) return null;
  if (!isCentreCode(row.centre)) return null;

  return {
    rowId: row.id,
    publicId: row.public_id,
    title: titleOf(row),
    centre: row.centre,
    clientKey: CENTRES[row.centre].clientKey,
    eventDate: ymdOf(row.event_date),
    eventTime: row.event_time ? row.event_time.slice(0, 5) : null,
    guests: Number(row.guests) || 0,
    statusId: row.status_id,
    bmiProjectId: row.bmi_project_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phoneE164: row.phone_e164,
  };
}

/**
 * Attach an Office project to a lead — but ONLY while it has none.
 *
 * ONE WRITER PER BMI ENTITY (R5). B3's mint rail and this builder can both
 * decide a lead needs a project; the `WHERE bmi_project_id IS NULL` is what
 * stops the second one overwriting the first and stranding a project nobody
 * will ever look at again. A caller that gets `null` back has LOST the race
 * and must adopt the winner's project rather than its own.
 *
 * `mint_status` moves to `minted` in the same statement, so a reader can never
 * see a lead that has a project id and still claims to be pending.
 */
export async function claimLeadProject(
  leadRowId: string,
  projectId: string,
): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q`
    UPDATE crm_leads
       SET bmi_project_id = ${projectId},
           mint_status = 'minted',
           mint_error = NULL,
           bmi_synced_at = NOW(),
           updated_at = NOW()
     WHERE id = ${leadRowId}::bigint
       AND bmi_project_id IS NULL
    RETURNING bmi_project_id
  `) as Array<{ bmi_project_id: string }>;
  return rows[0]?.bmi_project_id ?? null;
}

/** Record a failed attempt so the deal page can say why, without a retry loop. */
export async function recordMintFailure(leadRowId: string, error: string): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureLeadsSchema();
    const q = sql();
    await q`
      UPDATE crm_leads
         SET mint_status = CASE WHEN bmi_project_id IS NULL THEN 'failed' ELSE mint_status END,
             mint_error = ${error.slice(0, 500)},
             mint_attempts = mint_attempts + 1,
             updated_at = NOW()
       WHERE id = ${leadRowId}::bigint
    `;
  } catch (err) {
    console.error("[crm] mint failure not recorded", {
      lead_id: leadRowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Keep the lead's event date in step when the builder moves the project. */
export async function updateLeadEventDate(leadRowId: string, date: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureLeadsSchema();
  const q = sql();
  await q`
    UPDATE crm_leads
       SET event_date = ${date}::date, updated_at = NOW()
     WHERE id = ${leadRowId}::bigint
  `;
}
