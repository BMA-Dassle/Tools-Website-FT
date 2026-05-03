import { sql, isDbConfigured } from "@/lib/db";

/**
 * Kids Bowl Free (KBF) center-report sync.
 *
 * KBF's center-report admin (https://kidsbowlfree.com/center-report.php)
 * is the registration list for our HeadPinz Fort Myers / HeadPinz
 * Naples / Lehigh Lanes participation in the program. This module
 * pulls the daily CSV download — same flow a logged-in center user
 * sees in the browser — and upserts it into Neon Postgres so we can:
 *
 *   - Match KBF kids to FastTrax / HeadPinz bookings
 *   - Drive marketing (email match against booking history)
 *   - Track redemption / game count per kid over time
 *
 * The auth flow is unusual: KBF returns no Set-Cookie / PHPSESSID
 * (verified via HAR + cookie-jar replay). The login POST and the
 * report POST must be issued from the same outbound IP within a
 * short window — the Sucuri Cloudproxy in front of KBF appears to
 * track auth state by source IP for ~minutes. On Vercel both POSTs
 * happen inside the same function invocation so they share an
 * egress IP.
 *
 * Two tables:
 *   - `kbf_passes`        one row per (email, center) registration
 *   - `kbf_pass_members`  the kids + adult family members linked
 *                         back to their parent pass
 *
 * Schema bootstraps via `ensureKbfSchema()` on first write — repeat
 * runs are no-ops thanks to `IF NOT EXISTS` everywhere.
 *
 * Env: KBF_PASSWORD (8-char center code; treat as a credential).
 */

const KBF_BASE = "https://kidsbowlfree.com";
const KBF_REPORT_PATH = "/center-report.php";

/**
 * Allowlist of KBF centers to actually sync. Our login covers a
 * third center (Lehigh Lanes) that we don't operate — its rows are
 * dropped at parse time and any pre-existing rows are pruned on
 * each sync (`pruneExcludedCenters` below). Update this list if we
 * take on additional centers.
 */
const INCLUDED_CENTERS = ["HeadPinz Fort Myers", "HeadPinz Naples"] as const;
const INCLUDED_CENTERS_SET: ReadonlySet<string> = new Set(INCLUDED_CENTERS);

// ── Types ───────────────────────────────────────────────────────────────────

export interface KbfPass {
  email: string;
  centerName: string;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  /** ISO timestamp; null if KBF gave us an unparseable date string. */
  dateAdded: string | null;
  /** True when KBF has marked this row as a fully-completed pass. */
  fpass: boolean;
  /** Raw birthday string from KBF — format varies ("MM/DD/YYYY" or
   *  "MM/YYYY" for kids without a known day). Stored verbatim so we
   *  don't lie about precision. */
  birthday: string;
  birthYear: number | null;
  specialCode: string;
  mailLink: string;
  /** Phone number (digits only). Optional — only set after the parent
   *  opts into SMS 2FA by saving their phone during a KBF booking. */
  phone?: string | null;
  /** Which channel to deliver the 2FA OTP on. 'email' is always
   *  available (we have email from the CSV); 'sms' is opt-in.
   *  Defaults to 'email' for legacy rows. */
  preferred2fa?: "sms" | "email";
  /** Demo / test row — bypasses the OTP step entirely so internal
   *  staff can demo from any device without a real KBF account. */
  isTest?: boolean;
}

export interface KbfPassMember {
  /** "kid" = enrolled kid receiving free games; "family" = adult
   *  joined the family pass tier. Both link to the parent pass. */
  relation: "kid" | "family";
  /** 1-indexed slot from the wide CSV (kid_*_1..6 or fam_*_1..4).
   *  Stable across syncs in practice — KBF reuses the same slot
   *  for the same kid. */
  slot: number;
  firstName: string;
  lastName: string;
  /** Kid only (family members have no birthday in the CSV). */
  birthday: string;
  redemptions: number;
  games: number;
  avgScore: number | null;
}

interface ParsedRow {
  pass: KbfPass;
  members: KbfPassMember[];
}

// ── Download ────────────────────────────────────────────────────────────────

/** Fetch with a hard timeout. KBF's Sucuri Cloudproxy regularly
 *  takes 30-60s during their business hours; without this the cron
 *  function hits the 60s Vercel ceiling and 504s with no chance to
 *  retry. Bounded at 25s so we have headroom for one retry within
 *  the function's 60s budget. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True for the kinds of failures we want to retry: timeout aborts,
 *  network errors, 5xx responses, and the silent-empty-CSV / auth-
 *  lapse conditions where a fresh login often clears it. Auth-config
 *  errors (missing env, missing PHPSESSID) are NOT retried — re-
 *  hitting with the same bad config wastes the budget. */
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "AbortError") return true;
  if (/HTTP 5\d\d/.test(msg)) return true;
  if (/empty CSV/i.test(msg)) return true;
  if (/unexpected content-type/i.test(msg)) return true;
  if (/fetch failed|network|ECONN|ETIMEDOUT/i.test(msg)) return true;
  return false;
}

/**
 * Two-POST sequence: login (form=login) → report (form=report).
 * Returns the raw CSV string. Throws on auth failure / non-CSV
 * response (e.g. KBF redirected us back to the login page because
 * the password expired).
 *
 * KBF auth state is bound to the PHPSESSID cookie returned by the
 * login response — we capture it and forward it on the report POST.
 * Without the cookie, KBF responds 200 with content-type=csv but
 * an empty body (silent auth failure).
 *
 * Retry policy: on timeout / 5xx / silent-empty / content-type-html,
 * sleep briefly and retry once with a fresh login. KBF's Sucuri
 * Cloudproxy goes slow during peak business hours (12-21 UTC) and
 * was timing out the cron repeatedly; one retry on a fresh session
 * usually clears it without bumping the function ceiling.
 */
export async function downloadKbfCsv(): Promise<string> {
  const password = process.env.KBF_PASSWORD || "";
  if (!password) throw new Error("KBF_PASSWORD env var not set");

  const PER_REQUEST_TIMEOUT_MS = 25_000;
  const MAX_ATTEMPTS = 2;
  const BACKOFF_MS = 2_000;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadKbfCsvOnce(password, PER_REQUEST_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        console.warn(
          `[kbf-sync] download attempt ${attempt}/${MAX_ATTEMPTS} failed (${msg}); retrying in ${BACKOFF_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, BACKOFF_MS));
        continue;
      }
      throw err;
    }
  }
  // Unreachable — loop either returns or throws — but TS needs the assertion.
  throw lastErr instanceof Error ? lastErr : new Error("kbf-sync: download failed");
}

/** One full login + report attempt. Throws on any non-clean path so
 *  the wrapper above can decide whether to retry. */
async function downloadKbfCsvOnce(
  password: string,
  timeoutMs: number,
): Promise<string> {
  const ua = "FastTrax-KBF-Sync/1.0";

  const loginRes = await fetchWithTimeout(
    `${KBF_BASE}${KBF_REPORT_PATH}`,
    {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": KBF_BASE,
        "Referer": `${KBF_BASE}${KBF_REPORT_PATH}?logout=1`,
      },
      body: `form=login&password=${encodeURIComponent(password)}&login=Login`,
      redirect: "manual", // we don't need to follow; auth state is established server-side
      cache: "no-store",
    },
    timeoutMs,
  );
  // 302 = success (Location: /center-report.php), 200 = also accepted
  // by some Sucuri configurations. Anything else is a hard fail.
  if (loginRes.status !== 302 && !loginRes.ok) {
    throw new Error(`KBF login failed: HTTP ${loginRes.status}`);
  }

  // Pull PHPSESSID off the login response and forward it. Without
  // this the report POST silently returns an empty CSV.
  const setCookie = loginRes.headers.get("set-cookie") || "";
  const phpSessId = /PHPSESSID=([^;]+)/.exec(setCookie)?.[1] || "";
  if (!phpSessId) {
    throw new Error(
      "KBF login did not issue PHPSESSID cookie — re-check KBF_PASSWORD",
    );
  }

  const reportRes = await fetchWithTimeout(
    `${KBF_BASE}${KBF_REPORT_PATH}`,
    {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": KBF_BASE,
        "Referer": `${KBF_BASE}${KBF_REPORT_PATH}`,
        "Cookie": `PHPSESSID=${phpSessId}`,
      },
      body: "form=report",
      cache: "no-store",
    },
    timeoutMs,
  );
  if (!reportRes.ok) {
    throw new Error(`KBF report fetch failed: HTTP ${reportRes.status}`);
  }
  const ct = reportRes.headers.get("content-type") || "";
  if (!ct.includes("csv")) {
    // Auth lapsed → KBF returned the HTML login page instead of CSV.
    // Surface this loudly so the cron alert points at the right thing.
    throw new Error(`KBF report unexpected content-type: ${ct} (auth likely lapsed — re-check KBF_PASSWORD)`);
  }
  const body = await reportRes.text();
  if (body.length === 0) {
    throw new Error(
      "KBF report returned empty CSV — session cookie likely rejected (re-check KBF_PASSWORD)",
    );
  }
  return body;
}

// ── CSV parsing ─────────────────────────────────────────────────────────────

/**
 * RFC4180-ish CSV parser. KBF wraps every field in double quotes
 * and escapes embedded quotes as `""`. Fields can contain commas
 * (street addresses) and the parser handles \r\n line endings.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function toIntOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
function toFloatOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * KBF's date_added is a naive timestamp like "2026-04-16 08:50:35"
 * with no timezone. KBF runs out of the eastern US — treat it as ET.
 * Close enough for hourly cohort analysis; we're not doing cross-DST
 * rollover math against this column.
 */
function parseDateAdded(s: string): string | null {
  if (!s) return null;
  // Append an ET offset. -04:00 in summer (EDT), -05:00 in winter (EST);
  // we use -05:00 as the "stable" offset because KBF's CSV format
  // doesn't change between DST transitions and the hour-level drift
  // is irrelevant for reporting that buckets by day.
  const t = Date.parse(s.replace(" ", "T") + "-05:00");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function parseKbfCsv(csv: string): ParsedRow[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  const colIdx = new Map<string, number>();
  header.forEach((h, i) => colIdx.set(h, i));

  const out: ParsedRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 14) continue; // malformed line — skip silently

    const get = (name: string): string => {
      const i = colIdx.get(name);
      return i !== undefined ? (row[i] ?? "").trim() : "";
    };

    const email = get("email").toLowerCase();
    if (!email) continue;

    const centerName = get("center_name").trim();
    // Allowlist filter — drop centers we don't operate (currently
    // Lehigh Lanes). See INCLUDED_CENTERS at top of file.
    if (!INCLUDED_CENTERS_SET.has(centerName)) continue;

    const pass: KbfPass = {
      email,
      centerName,
      firstName: get("first_name"),
      lastName: get("last_name"),
      address: get("address"),
      city: get("city"),
      state: get("state"),
      zip: get("zip"),
      dateAdded: parseDateAdded(get("date_added")),
      fpass: get("fpass") === "1",
      birthday: get("birthday"),
      birthYear: toIntOrNull(get("birth_year")),
      specialCode: get("special_code"),
      mailLink: get("mail_link"),
    };

    const members: KbfPassMember[] = [];

    // Up to 6 kid slots per pass
    for (let k = 1; k <= 6; k++) {
      const fn = get(`kid_firstname_${k}`);
      const ln = get(`kid_lastname_${k}`);
      const bd = get(`kid_bday_${k}`);
      if (!fn && !ln && !bd) continue;
      members.push({
        relation: "kid",
        slot: k,
        firstName: fn,
        lastName: ln,
        birthday: bd,
        redemptions: toIntOrNull(get(`kid_redemptions_${k}`)) ?? 0,
        games: toIntOrNull(get(`kid_games_${k}`)) ?? 0,
        avgScore: toFloatOrNull(get(`kid_avg_score_${k}`)),
      });
    }

    // Up to 4 family-member slots
    for (let f = 1; f <= 4; f++) {
      const fn = get(`fam_firstname_${f}`);
      const ln = get(`fam_lastname_${f}`);
      if (!fn && !ln) continue;
      members.push({
        relation: "family",
        slot: f,
        firstName: fn,
        lastName: ln,
        birthday: "",
        redemptions: toIntOrNull(get(`fam_redemptions_${f}`)) ?? 0,
        games: toIntOrNull(get(`fam_games_${f}`)) ?? 0,
        avgScore: toFloatOrNull(get(`fam_avg_score_${f}`)),
      });
    }

    out.push({ pass, members });
  }
  return out;
}

// ── Schema bootstrap ────────────────────────────────────────────────────────

let schemaReady = false;
export async function ensureKbfSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kbf_passes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      center_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      date_added TIMESTAMPTZ,
      fpass BOOLEAN,
      birthday TEXT,
      birth_year INTEGER,
      special_code TEXT,
      mail_link TEXT,
      first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (email, center_name)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS kbf_passes_email_idx ON kbf_passes((lower(email)))`;
  await q`CREATE INDEX IF NOT EXISTS kbf_passes_date_added_idx ON kbf_passes(date_added DESC)`;
  await q`CREATE INDEX IF NOT EXISTS kbf_passes_center_idx ON kbf_passes(center_name)`;
  // Forward-compatible additions for the in-app KBF booking flow.
  // ALTER ADD COLUMN IF NOT EXISTS is idempotent — safe to run on
  // every cold start.
  await q`ALTER TABLE kbf_passes ADD COLUMN IF NOT EXISTS phone TEXT`;
  await q`ALTER TABLE kbf_passes ADD COLUMN IF NOT EXISTS preferred_2fa TEXT DEFAULT 'email'`;
  await q`ALTER TABLE kbf_passes ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE`;
  // Phone-lookup index — supports the booking flow's phone-based login
  // path. Partial index since most legacy rows have NULL phone.
  await q`CREATE INDEX IF NOT EXISTS kbf_passes_phone_idx ON kbf_passes(phone) WHERE phone IS NOT NULL`;

  await q`
    CREATE TABLE IF NOT EXISTS kbf_pass_members (
      id SERIAL PRIMARY KEY,
      pass_id INTEGER NOT NULL REFERENCES kbf_passes(id) ON DELETE CASCADE,
      relation TEXT NOT NULL CHECK (relation IN ('kid', 'family')),
      slot INTEGER NOT NULL,
      first_name TEXT,
      last_name TEXT,
      birthday TEXT,
      redemptions INTEGER,
      games INTEGER,
      avg_score NUMERIC(5, 2),
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (pass_id, relation, slot)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS kbf_pass_members_pass_idx ON kbf_pass_members(pass_id)`;

  schemaReady = true;
}

// ── Upsert ──────────────────────────────────────────────────────────────────

export interface SyncResult {
  rowsParsed: number;
  passesUpserted: number;
  membersInserted: number;
  /** Rows pruned because their center is not in INCLUDED_CENTERS.
   *  Self-healing — the parser drops them too, so this just cleans
   *  up anything inserted before the allowlist existed (or before
   *  a center was removed from it). */
  centersPruned: number;
  durationMs: number;
}

/**
 * Delete any kbf_passes rows whose center is no longer in the
 * allowlist. Members cascade via the FK. Idempotent — returns 0
 * rows once steady-state is reached.
 */
async function pruneExcludedCenters(): Promise<number> {
  const q = sql();
  const allowed = [...INCLUDED_CENTERS] as string[];
  const deleted = (await q`
    DELETE FROM kbf_passes
    WHERE center_name <> ALL(${allowed}::text[])
    RETURNING id
  `) as { id: number }[];
  return deleted.length;
}

/**
 * Bulk upsert via UNNEST. Postgres flattens parallel arrays into a
 * tuple stream, so 2k+ rows go in one round-trip instead of N
 * round-trips. The members table is rebuilt wholesale per pass so
 * removed kids / shifted slots clean up correctly.
 */
export async function syncKbfFromCsv(csv: string): Promise<SyncResult> {
  const t0 = Date.now();
  if (!isDbConfigured()) {
    throw new Error("DATABASE_URL not configured — cannot sync");
  }
  await ensureKbfSchema();
  // Prune any rows from centers no longer on the allowlist BEFORE
  // upserting today's parse — keeps the cleanup tied to a real sync
  // run, not just any time the schema is touched.
  const centersPruned = await pruneExcludedCenters();
  const parsed = parseKbfCsv(csv);
  if (parsed.length === 0) {
    return { rowsParsed: 0, passesUpserted: 0, membersInserted: 0, centersPruned, durationMs: Date.now() - t0 };
  }
  const q = sql();

  // Flatten the pass column-vectors for UNNEST
  const emails = parsed.map(p => p.pass.email);
  const centers = parsed.map(p => p.pass.centerName);
  const firstNames = parsed.map(p => p.pass.firstName);
  const lastNames = parsed.map(p => p.pass.lastName);
  const addresses = parsed.map(p => p.pass.address);
  const cities = parsed.map(p => p.pass.city);
  const states = parsed.map(p => p.pass.state);
  const zips = parsed.map(p => p.pass.zip);
  const dateAdded = parsed.map(p => p.pass.dateAdded);
  const fpass = parsed.map(p => p.pass.fpass);
  const birthdays = parsed.map(p => p.pass.birthday);
  const birthYears = parsed.map(p => p.pass.birthYear);
  const specialCodes = parsed.map(p => p.pass.specialCode);
  const mailLinks = parsed.map(p => p.pass.mailLink);

  const upserted = (await q`
    INSERT INTO kbf_passes (
      email, center_name, first_name, last_name, address, city, state, zip,
      date_added, fpass, birthday, birth_year, special_code, mail_link
    )
    SELECT * FROM UNNEST(
      ${emails}::text[],
      ${centers}::text[],
      ${firstNames}::text[],
      ${lastNames}::text[],
      ${addresses}::text[],
      ${cities}::text[],
      ${states}::text[],
      ${zips}::text[],
      ${dateAdded}::timestamptz[],
      ${fpass}::boolean[],
      ${birthdays}::text[],
      ${birthYears}::int[],
      ${specialCodes}::text[],
      ${mailLinks}::text[]
    )
    ON CONFLICT (email, center_name) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      address = EXCLUDED.address,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      zip = EXCLUDED.zip,
      date_added = EXCLUDED.date_added,
      fpass = EXCLUDED.fpass,
      birthday = EXCLUDED.birthday,
      birth_year = EXCLUDED.birth_year,
      special_code = EXCLUDED.special_code,
      mail_link = EXCLUDED.mail_link,
      last_synced_at = NOW()
    RETURNING id, email, center_name
  `) as { id: number; email: string; center_name: string }[];

  const idByKey = new Map<string, number>();
  for (const r of upserted) idByKey.set(`${r.email}|${r.center_name}`, r.id);

  // Rebuild member rows. Delete-then-insert per-pass is bulletproof
  // against KBF reordering kids / a kid leaving the family. Volume
  // is small (~6k rows total) so a flat delete + bulk insert is fine.
  const passIds = upserted.map(r => r.id);
  if (passIds.length > 0) {
    await q`DELETE FROM kbf_pass_members WHERE pass_id = ANY(${passIds}::int[])`;
  }

  const m_passId: number[] = [];
  const m_relation: string[] = [];
  const m_slot: number[] = [];
  const m_firstName: string[] = [];
  const m_lastName: string[] = [];
  const m_birthday: string[] = [];
  const m_redemptions: number[] = [];
  const m_games: number[] = [];
  const m_avgScore: (number | null)[] = [];

  for (const p of parsed) {
    const passId = idByKey.get(`${p.pass.email}|${p.pass.centerName}`);
    if (!passId) continue;
    for (const m of p.members) {
      m_passId.push(passId);
      m_relation.push(m.relation);
      m_slot.push(m.slot);
      m_firstName.push(m.firstName);
      m_lastName.push(m.lastName);
      m_birthday.push(m.birthday);
      m_redemptions.push(m.redemptions);
      m_games.push(m.games);
      m_avgScore.push(m.avgScore);
    }
  }

  let membersInserted = 0;
  if (m_passId.length > 0) {
    const inserted = (await q`
      INSERT INTO kbf_pass_members (
        pass_id, relation, slot, first_name, last_name, birthday,
        redemptions, games, avg_score
      )
      SELECT * FROM UNNEST(
        ${m_passId}::int[],
        ${m_relation}::text[],
        ${m_slot}::int[],
        ${m_firstName}::text[],
        ${m_lastName}::text[],
        ${m_birthday}::text[],
        ${m_redemptions}::int[],
        ${m_games}::int[],
        ${m_avgScore}::numeric[]
      )
      RETURNING id
    `) as { id: number }[];
    membersInserted = inserted.length;
  }

  return {
    rowsParsed: parsed.length,
    passesUpserted: upserted.length,
    membersInserted,
    centersPruned,
    durationMs: Date.now() - t0,
  };
}
