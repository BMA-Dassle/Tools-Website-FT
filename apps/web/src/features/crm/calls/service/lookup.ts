/**
 * `GET /api/crm/3cx/lookup?number=…` — what the PBX pops on the agent's screen
 * when a call arrives.
 *
 * The 3CX CRM-Integration template expects a flat contact: a name, a number, a
 * company and a URL it can open. We answer from `crm_contacts` (matched by the
 * last ten digits, `service/match.ts`) and point the URL at the DEAL, because
 * that is what the person answering actually wants — the enquiry, not a
 * contact card.
 *
 * NEVER LEAKS. A number we do not know answers `{contact: null}`, not a guess
 * and not an error; the endpoint is reachable by anyone holding the shared
 * secret, so it returns one contact's public details and nothing else — no
 * lead list, no notes, no money.
 *
 * The URL is ABSOLUTE and always production (`https://headpinz.com/admin/crm/…`
 * unless `ADMIN_PUBLIC_URL` says otherwise): the PBX hands it to a desktop
 * client, where a relative path means nothing, and a preview host would be
 * wrong the moment the branch merges (same reasoning as the Teams card's
 * "Open in CRM" link, §5.7b).
 */

import { isDbConfigured, sql } from "@ft/db";
import { CRM_BASE } from "../../core/contracts";
import type { ThreecxLookupContact } from "../contracts";
import { lastTen } from "./match";

/** Where a link handed to an external system points. */
export const CRM_PUBLIC_ORIGIN = "https://headpinz.com";

export function crmAbsoluteUrl(path: string): string {
  const origin = (process.env.ADMIN_PUBLIC_URL || CRM_PUBLIC_ORIGIN).replace(/\/+$/, "");
  return `${origin}${path}`;
}

interface LookupRowRaw {
  contact_id: string;
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  email: string | null;
  company: string | null;
  lead_public_id: string | null;
}

/** One contact for the PBX, or null when the number is a stranger. */
export async function lookupByNumber(
  number: string | null | undefined,
): Promise<ThreecxLookupContact | null> {
  const key = lastTen(number);
  if (!key || !isDbConfigured()) return null;
  const rows = (await sql().query(
    `SELECT c.id::text AS contact_id, c.first_name, c.last_name, c.phone_e164, c.email,
            a.name AS company, l.public_id AS lead_public_id
       FROM crm_contacts c
       LEFT JOIN crm_accounts a ON a.id = c.account_id
       LEFT JOIN LATERAL (
         SELECT l.public_id
           FROM crm_leads l
           LEFT JOIN crm_statuses s ON s.id = l.status_id
          WHERE l.contact_id = c.id AND l.archived_at IS NULL
          ORDER BY (s.kind = 'open') DESC NULLS LAST, l.created_at DESC, l.id DESC
          LIMIT 1
       ) l ON TRUE
      WHERE right(regexp_replace(c.phone_e164, '\\D', '', 'g'), 10) = $1
      ORDER BY (l.public_id IS NOT NULL) DESC, c.updated_at DESC, c.id DESC
      LIMIT 1`,
    [key],
  )) as LookupRowRaw[];

  const hit = rows[0];
  if (!hit) return null;
  return {
    id: hit.contact_id,
    firstname: hit.first_name ?? "",
    lastname: hit.last_name ?? "",
    phone: hit.phone_e164 ?? "",
    email: hit.email ?? "",
    company: hit.company ?? "",
    crmurl: crmAbsoluteUrl(
      hit.lead_public_id
        ? `${CRM_BASE}/deal/${encodeURIComponent(hit.lead_public_id)}`
        : `${CRM_BASE}/calls`,
    ),
  };
}
