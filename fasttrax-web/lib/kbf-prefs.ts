import { sql, isDbConfigured } from "@/lib/db";

/**
 * Kids Bowl Free booking-flow data layer.
 *
 * `lib/kbf-sync.ts` owns the daily CSV import (the `kbf_passes` and
 * `kbf_pass_members` tables and their write paths). This module owns
 * the *read* path used by the in-app booking flow, plus a small new
 * `kbf_member_prefs` table that captures per-member preferences
 * (shoe size, bumper preference, last-used center) so the wizard
 * can pre-fill them on the next visit without re-asking.
 *
 * Why a separate module: keeps the CSV sync single-purpose and lets
 * the booking routes import only what they need without pulling in
 * `downloadKbfCsv` and friends.
 *
 * Schema bootstraps via `ensureKbfBookingSchema()` on first read.
 * Repeat runs are no-ops thanks to `IF NOT EXISTS` everywhere.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface KbfPassRow {
  id: number;
  email: string;
  centerName: string;
  firstName: string;
  lastName: string;
  /** Digits only; null if the parent hasn't opted into SMS 2FA. */
  phone: string | null;
  preferred2fa: "sms" | "email";
  isTest: boolean;
  fpass: boolean;
}

export interface KbfMemberRow {
  id: number;
  passId: number;
  relation: "kid" | "family";
  slot: number;
  firstName: string;
  lastName: string;
  birthday: string;
  redemptions: number;
  games: number;
  /** Pre-filled from `kbf_member_prefs` if we've booked them before. */
  prefs?: KbfMemberPref | null;
}

export interface KbfPassWithMembers extends KbfPassRow {
  members: KbfMemberRow[];
}

export interface KbfMemberPref {
  passId: number;
  memberSlot: number;
  /** Member relation key — paired with slot to disambiguate kid #1
   *  from family-adult #1 (both have slot=1 in the source CSV). */
  relation: "kid" | "family";
  /** QAMF shoe-size category id (e.g. 40 for "KM 2.5"). */
  shoeSizeId: number | null;
  /** QAMF shoe-size display label (e.g. "KM 2.5"). */
  shoeSizeLabel: string | null;
  /** True if this person rents shoes when they bowl. Persisted as
   *  a separate flag (instead of "shoeSizeId != null") so we can
   *  remember "they're a regular shoe-renter" even when we haven't
   *  captured their size yet. */
  wantShoes: boolean | null;
  wantBumpers: boolean | null;
  /** "fortmyers" | "naples". */
  lastUsedCenter: string | null;
  updatedAt: string;
}

// ── Schema bootstrap ────────────────────────────────────────────────────────

let schemaReady = false;
export async function ensureKbfBookingSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kbf_member_prefs (
      pass_id INTEGER NOT NULL REFERENCES kbf_passes(id) ON DELETE CASCADE,
      member_slot INTEGER NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('kid', 'family')),
      shoe_size_id INTEGER,
      shoe_size_label TEXT,
      want_shoes BOOLEAN,
      want_bumpers BOOLEAN,
      last_used_center TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pass_id, relation, member_slot)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS kbf_member_prefs_pass_idx ON kbf_member_prefs(pass_id)`;
  // Forward-compatible: if the table existed before want_shoes was
  // introduced, add the column idempotently.
  await q`ALTER TABLE kbf_member_prefs ADD COLUMN IF NOT EXISTS want_shoes BOOLEAN`;
  schemaReady = true;
}

// ── Pass lookups ────────────────────────────────────────────────────────────

interface PassQueryRow {
  id: number;
  email: string;
  center_name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  preferred_2fa: string | null;
  is_test: boolean | null;
  fpass: boolean | null;
}

function rowToPass(r: PassQueryRow): KbfPassRow {
  return {
    id: r.id,
    email: r.email,
    centerName: r.center_name,
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    phone: r.phone,
    preferred2fa: r.preferred_2fa === "sms" ? "sms" : "email",
    isTest: r.is_test === true,
    fpass: r.fpass === true,
  };
}

/**
 * Look up KBF accounts by email. Case-insensitive. Returns one row
 * per (email, center) combo — a parent registered at both Fort
 * Myers and Naples will yield two rows.
 */
export async function findPassesByEmail(email: string): Promise<KbfPassRow[]> {
  if (!isDbConfigured()) return [];
  await ensureKbfBookingSchema();
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];
  const q = sql();
  const rows = (await q`
    SELECT id, email, center_name, first_name, last_name, phone, preferred_2fa, is_test, fpass
    FROM kbf_passes
    WHERE lower(email) = ${normalized}
    ORDER BY id ASC
  `) as PassQueryRow[];
  return rows.map(rowToPass);
}

/**
 * Look up KBF accounts by phone. Phone is digits-only on disk;
 * caller must normalize before invoking.
 */
export async function findPassesByPhone(phone: string): Promise<KbfPassRow[]> {
  if (!isDbConfigured()) return [];
  await ensureKbfBookingSchema();
  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  if (digits.length < 10) return [];
  const q = sql();
  const rows = (await q`
    SELECT id, email, center_name, first_name, last_name, phone, preferred_2fa, is_test, fpass
    FROM kbf_passes
    WHERE phone = ${digits}
    ORDER BY id ASC
  `) as PassQueryRow[];
  return rows.map(rowToPass);
}

// ── Member loading ──────────────────────────────────────────────────────────

interface MemberQueryRow {
  id: number;
  pass_id: number;
  relation: string;
  slot: number;
  first_name: string | null;
  last_name: string | null;
  birthday: string | null;
  redemptions: number | null;
  games: number | null;
}

interface PrefQueryRow {
  pass_id: number;
  member_slot: number;
  relation: string;
  shoe_size_id: number | null;
  shoe_size_label: string | null;
  want_shoes: boolean | null;
  want_bumpers: boolean | null;
  last_used_center: string | null;
  updated_at: string;
}

function rowToMember(r: MemberQueryRow, pref?: KbfMemberPref | null): KbfMemberRow {
  return {
    id: r.id,
    passId: r.pass_id,
    relation: r.relation === "family" ? "family" : "kid",
    slot: r.slot,
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    birthday: r.birthday ?? "",
    redemptions: r.redemptions ?? 0,
    games: r.games ?? 0,
    prefs: pref ?? null,
  };
}

function rowToPref(r: PrefQueryRow): KbfMemberPref {
  return {
    passId: r.pass_id,
    memberSlot: r.member_slot,
    relation: r.relation === "family" ? "family" : "kid",
    shoeSizeId: r.shoe_size_id,
    shoeSizeLabel: r.shoe_size_label,
    wantShoes: r.want_shoes,
    wantBumpers: r.want_bumpers,
    lastUsedCenter: r.last_used_center,
    updatedAt: r.updated_at,
  };
}

/**
 * Bulk-load passes with their members + saved prefs in a single
 * round-trip per table. Returns one record per pass id with members
 * attached and (when present) prefs joined onto each member.
 */
export async function loadPassesWithMembers(passIds: number[]): Promise<KbfPassWithMembers[]> {
  if (passIds.length === 0) return [];
  if (!isDbConfigured()) return [];
  await ensureKbfBookingSchema();
  const q = sql();

  const passRows = (await q`
    SELECT id, email, center_name, first_name, last_name, phone, preferred_2fa, is_test, fpass
    FROM kbf_passes
    WHERE id = ANY(${passIds}::int[])
    ORDER BY id ASC
  `) as PassQueryRow[];

  const memberRows = (await q`
    SELECT id, pass_id, relation, slot, first_name, last_name, birthday, redemptions, games
    FROM kbf_pass_members
    WHERE pass_id = ANY(${passIds}::int[])
    ORDER BY pass_id ASC, relation ASC, slot ASC
  `) as MemberQueryRow[];

  const prefRows = (await q`
    SELECT pass_id, member_slot, relation, shoe_size_id, shoe_size_label,
           want_shoes, want_bumpers, last_used_center,
           updated_at::text AS updated_at
    FROM kbf_member_prefs
    WHERE pass_id = ANY(${passIds}::int[])
  `) as PrefQueryRow[];

  // Index prefs by (pass_id, relation, slot) for O(1) attach.
  const prefMap = new Map<string, KbfMemberPref>();
  for (const r of prefRows) {
    prefMap.set(`${r.pass_id}|${r.relation}|${r.member_slot}`, rowToPref(r));
  }

  const passes: KbfPassWithMembers[] = passRows.map((r) => ({
    ...rowToPass(r),
    members: [],
  }));
  const passById = new Map(passes.map((p) => [p.id, p]));

  for (const m of memberRows) {
    const pass = passById.get(m.pass_id);
    if (!pass) continue;
    const pref = prefMap.get(`${m.pass_id}|${m.relation}|${m.slot}`) ?? null;
    pass.members.push(rowToMember(m, pref));
  }
  return passes;
}

// ── Pref upsert ─────────────────────────────────────────────────────────────

export interface UpsertPrefInput {
  passId: number;
  memberSlot: number;
  relation: "kid" | "family";
  shoeSizeId?: number | null;
  shoeSizeLabel?: string | null;
  wantShoes?: boolean | null;
  wantBumpers?: boolean | null;
  lastUsedCenter?: string | null;
}

/**
 * Upsert one member's saved prefs. Called once per booked bowler
 * after a successful KBF reservation so the next visit can
 * pre-fill the bowler-selection step.
 *
 * `want_shoes` and `want_bumpers` are written verbatim (not
 * COALESCE'd) so an explicit `false` from the wizard overwrites a
 * stale `true` from a previous visit. Shoe size + label use
 * COALESCE so a "want shoes off" toggle doesn't clobber the saved
 * size — they get to keep it for next time.
 */
export async function upsertMemberPref(input: UpsertPrefInput): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureKbfBookingSchema();
  const q = sql();
  await q`
    INSERT INTO kbf_member_prefs (
      pass_id, member_slot, relation,
      shoe_size_id, shoe_size_label, want_shoes, want_bumpers, last_used_center,
      updated_at
    ) VALUES (
      ${input.passId},
      ${input.memberSlot},
      ${input.relation},
      ${input.shoeSizeId ?? null},
      ${input.shoeSizeLabel ?? null},
      ${input.wantShoes ?? null},
      ${input.wantBumpers ?? null},
      ${input.lastUsedCenter ?? null},
      NOW()
    )
    ON CONFLICT (pass_id, relation, member_slot) DO UPDATE SET
      shoe_size_id = COALESCE(EXCLUDED.shoe_size_id, kbf_member_prefs.shoe_size_id),
      shoe_size_label = COALESCE(EXCLUDED.shoe_size_label, kbf_member_prefs.shoe_size_label),
      want_shoes = COALESCE(EXCLUDED.want_shoes, kbf_member_prefs.want_shoes),
      want_bumpers = COALESCE(EXCLUDED.want_bumpers, kbf_member_prefs.want_bumpers),
      last_used_center = COALESCE(EXCLUDED.last_used_center, kbf_member_prefs.last_used_center),
      updated_at = NOW()
  `;
}

// ── Pass mutations (opt-in toggles) ─────────────────────────────────────────

/**
 * Save the parent's phone number on their pass row(s) and flip
 * `preferred_2fa` to 'sms' so future visits trigger an SMS OTP
 * instead of email. Idempotent — running with the same phone
 * twice is a no-op.
 */
export async function optInPhoneSmsTwoFactor(
  passIds: number[],
  phone: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  if (passIds.length === 0) return;
  const digits = phone.replace(/\D/g, "").replace(/^1/, "");
  if (digits.length !== 10) return;
  await ensureKbfBookingSchema();
  const q = sql();
  await q`
    UPDATE kbf_passes
    SET phone = ${digits},
        preferred_2fa = 'sms'
    WHERE id = ANY(${passIds}::int[])
  `;
}
