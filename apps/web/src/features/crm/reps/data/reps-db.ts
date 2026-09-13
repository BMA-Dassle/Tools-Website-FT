/**
 * `crm_reps` + `crm_rep_logins` — who sells, and which sign-in addresses map to
 * each of them.
 *
 * DDL is PR1's (brief §3.8); later PRs may only `ALTER TABLE … ADD COLUMN IF NOT
 * EXISTS` here. Pattern: `web-sales-audit-db.ts` — one memoised `ensureSchema`
 * promise per process, every public function short-circuits when Neon is not
 * configured so a local run without `DATABASE_URL` renders an empty CRM rather
 * than a 500.
 *
 * IDENTITY JOIN. A person signs in with an email; `crm_rep_logins` maps MANY
 * emails to ONE rep row (Guest Services staff all act as the `gs` bucket). The
 * rep's own mailbox (`crm_reps.email`) is accepted as a login too, so a rep
 * whose login row was never seeded still lands on their own record. Emails are
 * compared lowercased on both sides; the seed stores them lowercased.
 *
 * Ids leave this module as STRINGS (`id::text`) — nothing downstream does
 * arithmetic on a rep id and the wire contract says ids are strings.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CentreCode, CrmRep, RepRole } from "../../core/types";

let schemaReady: Promise<void> | null = null;

export function ensureRepsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_reps (
        id BIGSERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        initials TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('rep','bucket','hold','director')),
        email TEXT UNIQUE,
        sso_sub TEXT,
        bmi_user_id TEXT,
        bmi_username TEXT,
        seven_shifts_user_id INTEGER,
        vox_did TEXT,
        threecx_extension TEXT,
        teams_chat_id TEXT,
        phone_e164 TEXT,
        centres TEXT[] NOT NULL DEFAULT '{}',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`
      CREATE TABLE IF NOT EXISTS crm_rep_logins (
        email TEXT PRIMARY KEY,
        rep_id BIGINT NOT NULL REFERENCES crm_reps(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}

/** A `crm_reps` row as the neon driver returns it. */
export interface RepRowRaw {
  id: string;
  slug: string;
  display_name: string;
  first_name: string;
  initials: string;
  role: string;
  email: string | null;
  sso_sub: string | null;
  bmi_user_id: string | null;
  bmi_username: string | null;
  seven_shifts_user_id: number | null;
  vox_did: string | null;
  threecx_extension: string | null;
  teams_chat_id: string | null;
  phone_e164: string | null;
  centres: string[] | null;
  active: boolean;
  sort_order: number;
}

const REP_ROLES = new Set<RepRole>(["rep", "bucket", "hold", "director"]);
const CENTRE_CODES = new Set<CentreCode>(["HPFM", "FT", "HPN"]);

export function mapRepRow(r: RepRowRaw): CrmRep {
  return {
    id: String(r.id),
    slug: r.slug,
    displayName: r.display_name,
    firstName: r.first_name,
    initials: r.initials,
    role: REP_ROLES.has(r.role as RepRole) ? (r.role as RepRole) : "rep",
    email: r.email ?? null,
    ssoSub: r.sso_sub ?? null,
    bmiUserId: r.bmi_user_id ?? null,
    bmiUsername: r.bmi_username ?? null,
    sevenShiftsUserId: r.seven_shifts_user_id ?? null,
    voxDid: r.vox_did ?? null,
    threecxExtension: r.threecx_extension ?? null,
    teamsChatId: r.teams_chat_id ?? null,
    phoneE164: r.phone_e164 ?? null,
    centres: (r.centres ?? []).filter((c): c is CentreCode => CENTRE_CODES.has(c as CentreCode)),
    active: r.active !== false,
    sortOrder: typeof r.sort_order === "number" ? r.sort_order : 100,
  };
}

const REP_COLUMNS = `
  r.id::text AS id, r.slug, r.display_name, r.first_name, r.initials, r.role, r.email,
  r.sso_sub, r.bmi_user_id, r.bmi_username, r.seven_shifts_user_id, r.vox_did,
  r.threecx_extension, r.teams_chat_id, r.phone_e164, r.centres, r.active, r.sort_order
`;

/**
 * The rep a sign-in address acts as, or null.
 *
 * Login rows win over the rep's own mailbox, so an address that is BOTH a
 * bucket login and (mistakenly) a rep mailbox resolves the way the director
 * configured it. Inactive reps are never returned: a departed rep who signs in
 * gets a director-visible "no rep row" rather than their old queue.
 */
export async function findRepByLoginEmail(email: string): Promise<CrmRep | null> {
  const key = email.trim().toLowerCase();
  if (!key || !isDbConfigured()) return null;
  await ensureRepsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${REP_COLUMNS}, (l.email IS NOT NULL) AS via_login
       FROM crm_reps r
       LEFT JOIN crm_rep_logins l ON l.rep_id = r.id AND lower(l.email) = $1
      WHERE r.active
        AND (l.email IS NOT NULL OR lower(r.email) = $1)
      ORDER BY via_login DESC, r.sort_order ASC, r.id ASC
      LIMIT 1`,
    [key],
  )) as RepRowRaw[];
  return rows[0] ? mapRepRow(rows[0]) : null;
}

/** Every active rep, buckets and holds included, in display order. */
export async function listReps(opts: { includeInactive?: boolean } = {}): Promise<CrmRep[]> {
  if (!isDbConfigured()) return [];
  await ensureRepsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${REP_COLUMNS}
       FROM crm_reps r
      WHERE ($1::boolean OR r.active)
      ORDER BY r.sort_order ASC, r.id ASC`,
    [opts.includeInactive === true],
  )) as RepRowRaw[];
  return rows.map(mapRepRow);
}
