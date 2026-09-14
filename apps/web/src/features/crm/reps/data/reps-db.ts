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
    /**
     * OFFICE USER IDS ARE PER TENANT, and `bmi_user_id` can only be right
     * about one of them.
     *
     * Measured off the mirror on 2026-09-14 — the same five people, two
     * tenants, ten different ids:
     *
     *            headpinzftmyers        headpinznaples
     *   Kelsea       28267036              6338800
     *   Lori           465247                41096
     *   Stephanie      465242              1559644
     *   Eric            75262                25228
     *   Guest Svcs   30080112              6400642  ← and NAMED "CallCenter"
     *
     * So every Office write on a Naples lead was sending a Fort Myers id and
     * being refused: `400 violation of FOREIGN KEY constraint "FK_PRJ_US_ID"
     * … F_US_ID = 30080112`, which is exactly what the owner saw on a lead's
     * timeline. Not a Guest Services problem — a problem for every rep, which
     * only Guest Services surfaced because kids' birthdays route there.
     *
     * A JSONB map of `clientKey → id` rather than a second column, because
     * "which tenant" is the key and there will be a third one the day a centre
     * is added. `bmi_user_id` stays as the fallback and as the KPI attribution
     * key, so nothing that reads it today changes.
     */
    await q`ALTER TABLE crm_reps ADD COLUMN IF NOT EXISTS bmi_user_ids JSONB`;
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
  bmi_user_ids: Record<string, string> | null;
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

/**
 * `{clientKey: id}` with every value forced to a STRING.
 *
 * Office ids exceed `Number.MAX_SAFE_INTEGER` in other tables and a JSONB
 * column will happily hand back a number, so anything non-string is coerced
 * here rather than trusted — the same discipline `parseWithRawIds` enforces on
 * the wire. A blank or non-object value is simply no map.
 */
function normaliseUserIds(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
    bmiUserIds: normaliseUserIds(r.bmi_user_ids),
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
  r.sso_sub, r.bmi_user_id, r.bmi_user_ids, r.bmi_username, r.seven_shifts_user_id, r.vox_did,
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

/** One row of the roster seed (`core/seed.ts` REP_SEED). */
export interface RepSeed {
  slug: string;
  displayName: string;
  firstName: string;
  initials: string;
  role: RepRole;
  email: string | null;
  bmiUserId: string | null;
  /** Office user id PER TENANT — `{clientKey: id}`; see `bmiUserIdFor`. */
  bmiUserIds?: Record<string, string> | null;
  bmiUsername: string | null;
  /** 7shifts user id (`seven_shifts_user_id INTEGER`) — a plain integer, bound as a number. */
  sevenShiftsUserId: number | null;
  teamsChatId: string | null;
  phoneE164: string | null;
  centres: CentreCode[];
  sortOrder: number;
}

/**
 * Upsert the roster seed by slug. A slug that does not exist yet is INSERTED in
 * full. A slug that already exists is HEALED, never overwritten: only
 * `bmi_user_id` / `bmi_username` / `seven_shifts_user_id` are touched, and only
 * where the row still holds NULL and the seed now knows the value (Jacob's
 * Office id and the planners' 7shifts ids both arrived after production had
 * been seeded). Every other column — and any non-NULL value an admin set by
 * hand — is left alone. The `WHERE` on the conflict arm makes a run with
 * nothing to heal a true no-op (no `updated_at` bump, nothing RETURNED), so
 * the count is rows the seed WROTE: inserted or healed.
 */
export async function seedReps(rows: readonly RepSeed[]): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureRepsSchema();
  const q = sql();
  let written = 0;
  for (const r of rows) {
    const out = (await q`
      INSERT INTO crm_reps (slug, display_name, first_name, initials, role, email, bmi_user_id,
                            bmi_user_ids, bmi_username, seven_shifts_user_id, teams_chat_id,
                            phone_e164, centres, sort_order)
      VALUES (${r.slug}, ${r.displayName}, ${r.firstName}, ${r.initials}, ${r.role},
              ${r.email ? r.email.toLowerCase() : null}, ${r.bmiUserId},
              ${r.bmiUserIds ? JSON.stringify(r.bmiUserIds) : null}::jsonb, ${r.bmiUsername},
              ${r.sevenShiftsUserId}, ${r.teamsChatId}, ${r.phoneE164}, ${r.centres}::text[],
              ${r.sortOrder})
      ON CONFLICT (slug) DO UPDATE SET
        bmi_user_id = COALESCE(crm_reps.bmi_user_id, EXCLUDED.bmi_user_id),
        -- The per-tenant map fills in even on a rep that already has a row:
        -- every existing roster predates the column, so COALESCE on a NULL is
        -- the ONLY way the measured ids ever reach a live database. A map a
        -- director has already edited by hand still wins.
        bmi_user_ids = COALESCE(crm_reps.bmi_user_ids, EXCLUDED.bmi_user_ids),
        bmi_username = COALESCE(crm_reps.bmi_username, EXCLUDED.bmi_username),
        seven_shifts_user_id = COALESCE(crm_reps.seven_shifts_user_id, EXCLUDED.seven_shifts_user_id),
        updated_at = NOW()
      WHERE (crm_reps.bmi_user_id IS NULL AND EXCLUDED.bmi_user_id IS NOT NULL)
         OR (crm_reps.bmi_user_ids IS NULL AND EXCLUDED.bmi_user_ids IS NOT NULL)
         OR (crm_reps.bmi_username IS NULL AND EXCLUDED.bmi_username IS NOT NULL)
         OR (crm_reps.seven_shifts_user_id IS NULL AND EXCLUDED.seven_shifts_user_id IS NOT NULL)
      RETURNING id
    `) as { id: string }[];
    written += out.length;
  }
  return written;
}

/** One `crm_rep_logins` row. */
export interface RepLoginRow {
  email: string;
  repId: string;
}

/**
 * Every explicit login mapping. The Rules screen needs them to answer "does
 * this call-centre agent already act as somebody?" — a rep's OWN mailbox is
 * not in here, so a caller that wants the full picture unions this with
 * `crm_reps.email`, the same precedence `findRepByLoginEmail` uses (login rows
 * win).
 */
export async function listRepLogins(): Promise<RepLoginRow[]> {
  if (!isDbConfigured()) return [];
  await ensureRepsSchema();
  const q = sql();
  const rows = (await q`
    SELECT lower(email) AS email, rep_id::text AS rep_id
      FROM crm_rep_logins
     ORDER BY email ASC
  `) as { email: string; rep_id: string }[];
  return rows.map((r) => ({ email: r.email, repId: String(r.rep_id) }));
}

/**
 * Point one sign-in address at a rep, or remove the mapping (`slug: null`).
 * Returns whether a row was written or deleted. A slug with no rep row writes
 * nothing — the caller's guard has already decided this is allowed (see
 * `rules/service/gs-members.ts`: department membership alone never maps an
 * address, or the directors in the call-centre department would sign in as the
 * Guest Services bucket).
 */
export async function setRepLogin(email: string, slug: string | null): Promise<boolean> {
  const key = email.trim().toLowerCase();
  if (!key || !isDbConfigured()) return false;
  await ensureRepsSchema();
  const q = sql();
  if (slug === null) {
    const gone =
      (await q`DELETE FROM crm_rep_logins WHERE lower(email) = ${key} RETURNING email`) as {
        email: string;
      }[];
    return gone.length > 0;
  }
  const out = (await q`
    INSERT INTO crm_rep_logins (email, rep_id)
    SELECT ${key}, id FROM crm_reps WHERE slug = ${slug}
    ON CONFLICT (email) DO UPDATE SET rep_id = EXCLUDED.rep_id
    RETURNING email
  `) as { email: string }[];
  return out.length > 0;
}

/** Insert login → rep rows that do not exist yet; a slug with no rep row is skipped. */
export async function seedRepLogins(
  rows: ReadonlyArray<{ email: string; slug: string }>,
): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureRepsSchema();
  const q = sql();
  let inserted = 0;
  for (const r of rows) {
    const out = (await q`
      INSERT INTO crm_rep_logins (email, rep_id)
      SELECT ${r.email.trim().toLowerCase()}, id FROM crm_reps WHERE slug = ${r.slug}
      ON CONFLICT (email) DO NOTHING
      RETURNING email
    `) as { email: string }[];
    inserted += out.length;
  }
  return inserted;
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
