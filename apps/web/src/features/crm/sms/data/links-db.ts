/**
 * WHO IS THIS NUMBER? — the read-only join the SMS sub needs and nobody else
 * has: a guest's E.164 → the `crm_contacts` row, their account name, and the
 * lead the conversation is about.
 *
 * READS ONLY. Every write to `crm_contacts` / `crm_leads` stays in the leads
 * sub (`upsertContact`, `createLead`); this module never inserts or updates.
 * It lives here rather than in `leads/` because B3 owns that sub's files while
 * its fix stage is in flight, and because "which lead is this text about" is an
 * SMS question: the newest live enquiry, which is what a rep means when they
 * open a thread.
 *
 * Nothing here touches a BMI id, so the plain driver values are safe; the ones
 * that exist (`crm_leads.bmi_project_id`) are already TEXT and are not selected.
 *
 * SCHEMA GUARD (§3.8). Every public function awaits the LEADS sub's
 * `ensureLeadsSchema()` — `crm_contacts`, `crm_accounts` and `crm_leads` are
 * that sub's tables, and this is the one reader that can reach them before it
 * has run: the public MO webhook resolves a guest number without the leads sub
 * ever being touched. `routeInbound` would catch the "relation does not exist"
 * and park the message for review, which loses nothing but reads in the log
 * like a Neon outage. `ensureLeadsSchema` memoises its promise, so this is one
 * await after the first call of the process.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureLeadsSchema } from "~/features/crm/leads";
import type { LinkedContact, LinkedLead } from "../types";

export interface GuestLink {
  contact: LinkedContact | null;
  lead: LinkedLead | null;
}

const EMPTY: GuestLink = { contact: null, lead: null };

interface ContactRow {
  id: string;
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  email: string | null;
  account_name: string | null;
}

interface LeadRow {
  id: string;
  public_id: string;
  source: string;
  is_prospect: boolean;
  assigned_rep_id: string | null;
  centre: string;
  event_date: string;
  event_type: string;
  guests: number;
  status_id: string;
}

function mapContact(r: ContactRow): LinkedContact {
  return {
    id: String(r.id),
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    phoneE164: r.phone_e164 ?? null,
    email: r.email ?? null,
    accountName: r.account_name ?? null,
  };
}

function mapLead(r: LeadRow): LinkedLead {
  return {
    id: String(r.id),
    publicId: r.public_id,
    source: r.source,
    isProspect: r.is_prospect === true,
    assignedRepId: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
    centre: r.centre,
    eventDate: r.event_date,
    eventType: r.event_type,
    guests: Number(r.guests ?? 0),
    statusId: r.status_id,
  };
}

/**
 * The lead a thread is about: the newest UN-archived lead for this contact.
 * A guest with two live enquiries gets the one they raised most recently,
 * which is the one a rep is texting about; the deal link in the header lets
 * them jump to the other.
 */
const LEAD_FOR_CONTACT = `
  SELECT l.id::text AS id, l.public_id, l.source, l.is_prospect,
         l.assigned_rep_id::text AS assigned_rep_id, l.centre,
         to_char(l.event_date, 'YYYY-MM-DD') AS event_date,
         l.event_type, l.guests, l.status_id
    FROM crm_leads l
   WHERE l.contact_id = $1::bigint AND l.archived_at IS NULL
   ORDER BY l.created_at DESC, l.id DESC
   LIMIT 1
`;

export async function contactByPhone(phoneE164: string): Promise<LinkedContact | null> {
  if (!isDbConfigured() || !phoneE164) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT c.id::text AS id, c.first_name, c.last_name, c.phone_e164, c.email,
            a.name AS account_name
       FROM crm_contacts c
       LEFT JOIN crm_accounts a ON a.id = c.account_id
      WHERE c.phone_e164 = $1
      ORDER BY c.id ASC
      LIMIT 1`,
    [phoneE164],
  )) as ContactRow[];
  return rows[0] ? mapContact(rows[0]) : null;
}

export async function leadForContact(contactId: string): Promise<LinkedLead | null> {
  if (!isDbConfigured() || !contactId) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(LEAD_FOR_CONTACT, [contactId])) as LeadRow[];
  return rows[0] ? mapLead(rows[0]) : null;
}

export async function leadById(leadId: string): Promise<LinkedLead | null> {
  if (!isDbConfigured() || !leadId) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT l.id::text AS id, l.public_id, l.source, l.is_prospect,
            l.assigned_rep_id::text AS assigned_rep_id, l.centre,
            to_char(l.event_date, 'YYYY-MM-DD') AS event_date,
            l.event_type, l.guests, l.status_id
       FROM crm_leads l WHERE l.id = $1::bigint`,
    [leadId],
  )) as LeadRow[];
  return rows[0] ? mapLead(rows[0]) : null;
}

export async function contactById(contactId: string): Promise<LinkedContact | null> {
  if (!isDbConfigured() || !contactId) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT c.id::text AS id, c.first_name, c.last_name, c.phone_e164, c.email,
            a.name AS account_name
       FROM crm_contacts c
       LEFT JOIN crm_accounts a ON a.id = c.account_id
      WHERE c.id = $1::bigint`,
    [contactId],
  )) as ContactRow[];
  return rows[0] ? mapContact(rows[0]) : null;
}

/** Contact + their current lead in one call; both null for a stranger. */
export async function resolveGuestLink(phoneE164: string): Promise<GuestLink> {
  const contact = await contactByPhone(phoneE164);
  if (!contact) return EMPTY;
  const lead = await leadForContact(contact.id);
  return { contact, lead };
}

/** Contact names for a page of threads, so the list does not fan out per row. */
export async function contactsByIds(ids: readonly string[]): Promise<Map<string, LinkedContact>> {
  const out = new Map<string, LinkedContact>();
  if (!isDbConfigured() || ids.length === 0) return out;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT c.id::text AS id, c.first_name, c.last_name, c.phone_e164, c.email,
            a.name AS account_name
       FROM crm_contacts c
       LEFT JOIN crm_accounts a ON a.id = c.account_id
      WHERE c.id = ANY($1::bigint[])`,
    [ids],
  )) as ContactRow[];
  for (const r of rows) out.set(String(r.id), mapContact(r));
  return out;
}

/** Contacts by number, for a page of threads whose rows were never linked. */
export async function contactsByPhones(
  phones: readonly string[],
): Promise<Map<string, LinkedContact>> {
  const out = new Map<string, LinkedContact>();
  if (!isDbConfigured() || phones.length === 0) return out;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT DISTINCT ON (c.phone_e164)
            c.id::text AS id, c.first_name, c.last_name, c.phone_e164, c.email,
            a.name AS account_name
       FROM crm_contacts c
       LEFT JOIN crm_accounts a ON a.id = c.account_id
      WHERE c.phone_e164 = ANY($1::text[])
      ORDER BY c.phone_e164, c.id ASC`,
    [phones],
  )) as ContactRow[];
  for (const r of rows) if (r.phone_e164) out.set(r.phone_e164, mapContact(r));
  return out;
}

/** Leads for a page of conversations, keyed by contact id. */
export async function leadsByContactIds(ids: readonly string[]): Promise<Map<string, LinkedLead>> {
  const out = new Map<string, LinkedLead>();
  if (!isDbConfigured() || ids.length === 0) return out;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT DISTINCT ON (l.contact_id)
            l.contact_id::text AS contact_id, l.id::text AS id, l.public_id, l.source,
            l.is_prospect, l.assigned_rep_id::text AS assigned_rep_id, l.centre,
            to_char(l.event_date, 'YYYY-MM-DD') AS event_date,
            l.event_type, l.guests, l.status_id
       FROM crm_leads l
      WHERE l.contact_id = ANY($1::bigint[]) AND l.archived_at IS NULL
      ORDER BY l.contact_id, l.created_at DESC, l.id DESC`,
    [ids],
  )) as (LeadRow & { contact_id: string })[];
  for (const r of rows) out.set(String(r.contact_id), mapLead(r));
  return out;
}
