/**
 * READ-ONLY lookup of one `crm_leads` row by its public id, so
 * `/admin/crm/availability/<leadId>` can seed the request bar from the lead's
 * own centre, date, time and guest count.
 *
 * WHY IT LIVES HERE. C4's base is `feat/crm`, where the leads sub is still DDL
 * only (B3 is landing in parallel and owns every reader and writer of
 * `crm_leads`). Rather than block, this sub reads the three columns it needs
 * through the DDL PR1 already shipped — the same arrangement B2 made for the
 * volume query (`rules/data/volume-db.ts`). It writes nothing, adds no column,
 * and the release step swaps it for B3's helper the moment one exists.
 *
 * The schema import is LAZY for the reason B2 documented: a static edge from
 * this sub to the leads barrel would close a runtime cycle between two eager
 * re-export barrels (§3.2 "never cyclically").
 */

import { isDbConfigured, sql } from "@ft/db";
import { isCentreCode } from "~/features/crm/core/centres";
import type { AvailabilityLead } from "../contracts";

let leadsSchemaReady: Promise<void> | null = null;

function ensureLeadsSchema(): Promise<void> {
  leadsSchemaReady ??= import("~/features/crm/leads")
    .then((m) => m.ensureLeadsSchema())
    .catch((err: unknown) => {
      leadsSchemaReady = null;
      throw err;
    });
  return leadsSchemaReady;
}

interface LeadRowRaw {
  public_id: string;
  centre: string;
  event_date: string | Date;
  event_time: string | null;
  guests: number | string;
  status_id: string;
  account_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** A DATE column comes back as a Date on some drivers and a string on others. */
function ymdOf(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** `l.guest.company || first last` — the prototype's `leadTitle` (crm-shared.js:83). */
function titleOf(row: LeadRowRaw): string {
  const company = row.account_name?.trim();
  if (company) return company;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || row.public_id;
}

/**
 * One lead by public id, or null when it does not exist. A null is an honest
 * answer the screen renders as "enter the request manually" — never a lead
 * invented to fill the bar.
 */
export async function findLeadForAvailability(publicId: string): Promise<AvailabilityLead | null> {
  if (!isDbConfigured()) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q`
    SELECT l.public_id,
           l.centre,
           l.event_date,
           l.event_time::text AS event_time,
           l.guests,
           l.status_id,
           a.name AS account_name,
           c.first_name,
           c.last_name
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
    publicId: row.public_id,
    title: titleOf(row),
    centre: row.centre,
    eventDate: ymdOf(row.event_date),
    eventTime: row.event_time,
    guests: Number(row.guests) || 0,
    statusId: row.status_id,
  };
}
