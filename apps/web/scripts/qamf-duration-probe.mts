/**
 * QAMF duration-accuracy live probe — tasks/bowling-reservation-flow-plan.md section 7.
 *
 * Determines which QAMF mechanism (if any) yields duration-accurate bowling
 * availability, mapping observations onto the plan's design branches:
 *   A  point-in-time Options.Time is already feasibility-filtered
 *   B  WebOffer.Id + Options.Time filter is honored by availability search
 *   C  window search (StartAt != EndAt) returns a feasibility-aware series
 *   D  no QAMF duration signal (windowed necessary-condition filter on our side)
 *   E  a trustworthy reservations-list endpoint exists (see list-res / P3)
 *
 * Usage (run from apps/web, with .env.local QAMF + Neon credentials):
 *   npx tsx scripts/qamf-duration-probe.mts baseline [--fixtures]
 *   npx tsx scripts/qamf-duration-probe.mts near-close --center 3148 --date 2026-07-28
 *   npx tsx scripts/qamf-duration-probe.mts list-res   --center 3148
 *   npx tsx scripts/qamf-duration-probe.mts window     --center 3148 --time 14:00
 *   npx tsx scripts/qamf-duration-probe.mts filter     --center 3148 --time 14:00
 *   npx tsx scripts/qamf-duration-probe.mts blocked    --center 3148 --date 2026-07-28 --time 14:00 [--no-cleanup] [--fixtures]
 *   npx tsx scripts/qamf-duration-probe.mts hold-codes --center 3148 --date 2026-07-28 --time 14:00
 *   npx tsx scripts/qamf-duration-probe.mts latency    --center 3148 --date 2026-07-28
 *   npx tsx scripts/qamf-duration-probe.mts cleanup    --center 3148
 *
 * Safety (write paths: blocked, hold-codes):
 *   - Every reservation is created Temporary (never Confirmed) with Title
 *     "ZZZ API PROBE - auto-deletes" and deleted in a finally block.
 *   - Every created hold is recorded in scripts/.qamf-probe-holds.json
 *     IMMEDIATELY after creation, so `cleanup` can find it after a crash.
 *   - QAMF expires Temporary holds after ~10 minutes — the crash backstop.
 *     The whole `blocked` run must fit inside that TTL (elapsed is printed).
 *   - Run against Naples (3148) on a quiet FUTURE weekday. Never same-day
 *     evening slots.
 *
 * Conventions copied from scripts/list-qamf-offers.ts (.env.local + per-center
 * token mint) and scripts/debug-vip-fri-sun.ts (Neon reads). Offer/option ids
 * are ALWAYS read from bowling_experience_offers / _duration_options — never
 * hardcoded (Naples ids differ from Fort Myers). QAMF ids are small ints /
 * GUID-ish strings, so plain res.json()/JSON.parse is safe here (the BMI
 * raw-id rule does not apply).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

/* ------------------------------------------------------------------ */
/*  Env — .env.local at the app root (works regardless of cwd)         */
/* ------------------------------------------------------------------ */

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = resolve(SCRIPT_DIR, "..");

try {
  const raw = readFileSync(resolve(APP_ROOT, ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  /* rely on ambient env */
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VER = "2025-12-01.1.0"; // pinned — matches lib/qamf-bowling.ts
const PROBE_TITLE = "ZZZ API PROBE - auto-deletes";
const STATE_FILE = resolve(SCRIPT_DIR, ".qamf-probe-holds.json");
const FIXTURES_DIR = resolve(APP_ROOT, "src/features/booking/service/__fixtures__/qamf-availability");
const MAX_SATURATION_HOLDS = 40; // runaway guard for the P6 saturation loop

interface CenterMeta {
  label: string;
  centerCode: string; // Square center code — the key into the bowling_* tables
}
const CENTER_META: Record<number, CenterMeta> = {
  9172: { label: "Fort Myers", centerCode: "TXBSQN0FEKQ11" },
  3148: { label: "Naples", centerCode: "PPTR5G2N0QXF7" },
};

// Center hours, 0-26h notation (matches the availability route). Hardcoded
// mirror of HP_LOCATIONS (lib/headpinz-locations.ts): BOTH centers are
// "Sun-Thu 11AM-12AM" / "Fri-Sat 11AM-2AM". Kept inline so this probe stays
// self-contained (no app import chain). Update here if holiday hours diverge.
const OPEN_HOUR = 11;
function closeHourFor(dow: number): number {
  return dow === 5 || dow === 6 ? 26 : 24; // Fri/Sat close 2AM, else midnight
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

const SUBCOMMANDS = [
  "baseline",
  "near-close",
  "list-res",
  "window",
  "filter",
  "blocked",
  "hold-codes",
  "latency",
  "cleanup",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

interface Args {
  sub: Subcommand;
  center: number;
  date: string; // YYYY-MM-DD
  timeMinutes: number; // minutes from midnight, center-local
  players: number;
  fixtures: boolean;
  noCleanup: boolean;
  offer?: string;
}

function usage(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(`QAMF duration-accuracy probe (tasks/bowling-reservation-flow-plan.md section 7)

Usage (run from apps/web):
  npx tsx scripts/qamf-duration-probe.mts <subcommand> [flags]

Subcommands:
  baseline    P1  weboffers census vs DB duration-option map (read-only, both centers)
  near-close  P2  point probes at close-30 / close-75 (read-only)
  list-res    P3  reservations-list endpoint discovery (read-only)
  window      P4  window-search semantics, EndAt = StartAt +30m/+2h/+4h (read-only)
  filter      P5  WebOffer.Id / Options.Time filter honoring (read-only)
  blocked     P6  THE decisive blocked-window experiment (WRITES, self-cleaning)
  hold-codes  P7  double-book vs duration-infeasible error vocabulary (WRITES)
  latency     P8  8/16/32 concurrent point probes, p50/p95 (read-only)
  cleanup         delete lingering probe holds (state file + title scan)

Flags:
  --center 9172|3148   QAMF center id (default 3148 Naples; baseline probes both)
  --date YYYY-MM-DD    probe date (default: next Tuesday at least 7 days out)
  --time HH:MM         probe time T, center-local (default 14:00)
  --players N          TotalPlayers for probes/holds (default 2)
  --offer <slug>       experience slug from bowling_experiences (default: the
                       center's VIP hourly experience for the date's weekday,
                       e.g. vip-mon-thur / vip-fri-sun)
  --fixtures           save every raw QAMF response to
                       src/features/booking/service/__fixtures__/qamf-availability/
  --no-cleanup         blocked only: leave the block in place for manual wizard
                       testing (prints hold ids; QAMF's ~10-min TTL still applies)

Env (.env.local at apps/web): DATABASE_URL, QAMF_BOWLING_CLIENT_ID,
QAMF_BOWLING_CLIENT_SECRET, optional QAMF_BOWLING_SUBSCRIPTION_KEY.
`);
  process.exit(1);
}

function defaultProbeDate(): string {
  // Next Tuesday at least 7 days out (quiet weekday, far from today's guests).
  const d = new Date();
  d.setDate(d.getDate() + 7);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
  return ymdOf(d);
}

function parseArgs(argv: string[]): Args {
  let sub: string | null = null;
  let center = 3148;
  let date = "";
  let time = "14:00";
  let players = 2;
  let fixtures = false;
  let noCleanup = false;
  let offer: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (sub) usage(`unexpected argument: ${a}`);
      sub = a;
      continue;
    }
    switch (a) {
      case "--center":
        center = parseInt(argv[++i] ?? "", 10);
        break;
      case "--date":
        date = argv[++i] ?? "";
        break;
      case "--time":
        time = argv[++i] ?? "";
        break;
      case "--players":
        players = parseInt(argv[++i] ?? "", 10);
        break;
      case "--offer":
        offer = argv[++i];
        break;
      case "--fixtures":
        fixtures = true;
        break;
      case "--no-cleanup":
        noCleanup = true;
        break;
      default:
        usage(`unknown flag: ${a}`);
    }
  }

  if (!sub) usage("missing subcommand");
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) usage(`unknown subcommand: ${sub}`);
  if (!CENTER_META[center]) usage(`--center must be 9172 (Fort Myers) or 3148 (Naples), got: ${center}`);
  if (!date) date = defaultProbeDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) usage(`--date must be YYYY-MM-DD, got: ${date}`);
  const tm = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!tm) usage(`--time must be HH:MM, got: ${time}`);
  const timeMinutes = parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10);
  if (timeMinutes < 0 || timeMinutes > 26 * 60) usage(`--time out of range (0-26h notation): ${time}`);
  if (!Number.isFinite(players) || players < 1) usage(`--players must be >= 1`);
  if (noCleanup && sub !== "blocked") {
    console.log("note: --no-cleanup only applies to the blocked subcommand; ignoring.\n");
    noCleanup = false;
  }

  return { sub: sub as Subcommand, center, date, timeMinutes, players, fixtures, noCleanup, offer };
}

/* ------------------------------------------------------------------ */
/*  Small utils                                                        */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function padr(v: string | number, n: number): string {
  const s = String(v);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function hr(ch = "=", n = 76): void {
  console.log(ch.repeat(n));
}
function header(title: string): void {
  console.log("");
  hr();
  console.log(title);
  hr();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayYmd(): string {
  return ymdOf(new Date());
}
function addDaysYmd(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return ymdOf(new Date(y, mo - 1, d + days));
}
function dowOf(date: string): number {
  return new Date(`${date}T12:00:00`).getDay(); // 0=Sun .. 6=Sat
}
/** ET offset by month — same heuristic as the availability route and
 *  scripts/debug-vip-fri-sun.ts (both centers are Eastern time). */
function tzOffsetFor(date: string): string {
  const month = parseInt(date.slice(5, 7), 10);
  return month >= 3 && month <= 11 ? "-04:00" : "-05:00";
}
/** ISO with offset for minutes-from-midnight in 0-26h notation; hours >= 24
 *  roll into the next calendar day (post-midnight weekend tail). */
function isoAt(date: string, minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  const calHour = h >= 24 ? h - 24 : h;
  const calDate = h >= 24 ? addDaysYmd(date, 1) : date;
  return `${calDate}T${pad2(calHour)}:${pad2(m)}:00${tzOffsetFor(date)}`;
}
function minLabel(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return h >= 24 ? `${pad2(h - 24)}:${pad2(m)} (+1d)` : `${pad2(h)}:${pad2(m)}`;
}
/** Shift an ISO-with-offset wall-clock time by N minutes, keeping the offset. */
function isoShiftMinutes(iso: string, deltaMinutes: number): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + deltaMinutes));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}T${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}${iso.slice(16)}`;
}
function fmtClockEt(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.round((p / 100) * (sortedAsc.length - 1)));
  return sortedAsc[idx];
}
function granularityMinutes(sortedMs: number[]): number | null {
  let best: number | null = null;
  for (let i = 1; i < sortedMs.length; i++) {
    const diff = Math.round((sortedMs[i] - sortedMs[i - 1]) / 60_000);
    if (diff > 0 && (best === null || diff < best)) best = diff;
  }
  return best;
}
const enc = encodeURIComponent;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/*  QAMF client (raw fetch — no lib/qamf-bowling import: that pulls in  */
/*  @/lib/redis via qamf-bowling-auth, which is app/server-scoped)      */
/* ------------------------------------------------------------------ */

const tokenCache = new Map<number, string>();

async function tokenFor(centerId: number): Promise<string> {
  const cached = tokenCache.get(centerId);
  if (cached) return cached;
  const clientId = process.env.QAMF_BOWLING_CLIENT_ID;
  const clientSecret = process.env.QAMF_BOWLING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("QAMF_BOWLING_CLIENT_ID / QAMF_BOWLING_CLIENT_SECRET not set — run from apps/web with .env.local.");
    process.exit(1);
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "bowling_reservations",
    center_id: String(centerId),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token mint failed for center ${centerId}: ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`Token mint for center ${centerId} returned no access_token`);
  tokenCache.set(centerId, json.access_token);
  return json.access_token;
}

interface QamfCall {
  centerId: number;
  method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  path: string;
  body?: unknown;
  apiVersion?: string;
  label: string;
}
interface QamfResult {
  status: number; // 0 = network error
  ok: boolean;
  ms: number;
  text: string;
  json: unknown;
}

interface FixtureEntry {
  label: string;
  centerId: number;
  request: { method: string; path: string; apiVersion: string; body?: unknown };
  response: { status: number; ms: number; body: unknown };
  at: string;
}
let fixturesEnabled = false;
let fixtureFileName = "";
const fixtureEntries: FixtureEntry[] = [];

/** Raw QAMF call. Never throws on HTTP errors — the exact status/body IS the
 *  data this probe exists to capture. Throws only on token-mint failure. */
async function qamfRaw(call: QamfCall): Promise<QamfResult> {
  const token = await tokenFor(call.centerId);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "api-version": call.apiVersion ?? API_VER,
    "content-type": "application/json",
  };
  const subKey = process.env.QAMF_BOWLING_SUBSCRIPTION_KEY;
  if (subKey) headers["Ocp-Apim-Subscription-Key"] = subKey;

  const started = Date.now();
  let status = 0;
  let text = "";
  try {
    const res = await fetch(`${BASE}${call.path}`, {
      method: call.method,
      headers,
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    text = `NETWORK ERROR: ${errMsg(err)}`;
  }
  const ms = Date.now() - started;
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text); // QAMF ids are small — plain parse is safe here
    } catch {
      /* non-JSON body; keep raw text */
    }
  }
  if (fixturesEnabled) {
    fixtureEntries.push({
      label: call.label,
      centerId: call.centerId,
      request: { method: call.method, path: call.path, apiVersion: call.apiVersion ?? API_VER, body: call.body },
      response: { status, ms, body: json ?? text },
      at: new Date().toISOString(),
    });
  }
  return { status, ok: status >= 200 && status < 300, ms, text, json };
}

function flushFixtures(): void {
  if (!fixturesEnabled || fixtureEntries.length === 0) return;
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = resolve(FIXTURES_DIR, `${fixtureFileName}.json`);
  writeFileSync(file, JSON.stringify(fixtureEntries, null, 2));
  console.log(`\n[fixtures] wrote ${fixtureEntries.length} raw QAMF exchanges to ${file}`);
}

/* ── availability search helpers ──────────────────────────────────── */

interface QamfTimeOption {
  Id: number | string;
  Minutes?: number;
}
interface QamfAvailability {
  BookedAt: string;
  TotalPlayers?: number;
  WebOffer?: {
    Id?: number | string;
    Title?: string;
    Options?: {
      Time?: QamfTimeOption[];
      Game?: Array<{ Id: number | string; GamesPerPlayer?: number }>;
      Unlimited?: Array<{ Id: number | string }>;
    };
  };
}
interface QamfWebOffer {
  Id: number | string;
  Title?: string;
  IsEnabled?: boolean | string;
  OpenType?: string;
  Options?: {
    Time?: QamfTimeOption[];
    Game?: Array<{ Id: number | string; GamesPerPlayer?: number }>;
    Unlimited?: Array<{ Id: number | string }>;
  };
}

async function searchAvail(opts: {
  centerId: number;
  startAt: string;
  endAt: string;
  players: number;
  offerId?: number;
  timeOptionIds?: number[];
  label: string;
}): Promise<QamfResult> {
  const webOffer: Record<string, unknown> = { Services: ["BookForLater"] };
  if (opts.offerId !== undefined) webOffer.Id = opts.offerId;
  if (opts.timeOptionIds !== undefined) {
    webOffer.Options = { Time: opts.timeOptionIds.map((id) => ({ Id: id })) };
  }
  return qamfRaw({
    centerId: opts.centerId,
    method: "POST",
    path: `/centers/${opts.centerId}/reservations/availability/search`,
    body: {
      Filter: {
        BookedAtRange: { StartAt: opts.startAt, EndAt: opts.endAt },
        TotalPlayers: opts.players,
        WebOffer: webOffer,
      },
    },
    label: opts.label,
  });
}

function searchPoint(
  centerId: number,
  iso: string,
  players: number,
  label: string,
  offerId?: number,
  timeOptionIds?: number[],
): Promise<QamfResult> {
  return searchAvail({ centerId, startAt: iso, endAt: iso, players, offerId, timeOptionIds, label });
}

function availabilities(r: QamfResult): QamfAvailability[] {
  if (r.json && typeof r.json === "object") {
    const a = (r.json as { Availabilities?: unknown }).Availabilities;
    if (Array.isArray(a)) return a as QamfAvailability[];
  }
  return [];
}
function entriesFor(r: QamfResult, offerId: number): QamfAvailability[] {
  return availabilities(r).filter((a) => String(a.WebOffer?.Id) === String(offerId));
}
function timeIds(entry: QamfAvailability): number[] {
  return (entry.WebOffer?.Options?.Time ?? []).map((t) => Number(t.Id));
}
function distinctOfferIds(r: QamfResult): string[] {
  return [...new Set(availabilities(r).map((a) => String(a.WebOffer?.Id ?? "?")))];
}
function distinctBookedAtMs(entries: QamfAvailability[]): number[] {
  const set = new Set<number>();
  for (const e of entries) {
    const t = Date.parse(e.BookedAt);
    if (Number.isFinite(t)) set.add(t);
  }
  return [...set].sort((a, b) => a - b);
}
function describeTimeOptions(entry: QamfAvailability, dbMinutesByOpt: Map<number, number>): string {
  const t = entry.WebOffer?.Options?.Time ?? [];
  if (t.length === 0) return "(no Time options)";
  return t
    .map((o) => {
      const id = Number(o.Id);
      const mins =
        typeof o.Minutes === "number" && o.Minutes > 0
          ? `${o.Minutes}m QAMF`
          : dbMinutesByOpt.has(id)
            ? `${dbMinutesByOpt.get(id)}m DB`
            : "?m";
      return `${id} (${mins})`;
    })
    .join(" | ");
}
function unwrapWebOffers(json: unknown): QamfWebOffer[] {
  if (Array.isArray(json)) return json as QamfWebOffer[];
  if (json && typeof json === "object") {
    const w = (json as { WebOffers?: unknown }).WebOffers;
    if (Array.isArray(w)) return w as QamfWebOffer[];
  }
  return [];
}
function shapeSummary(json: unknown): string {
  if (json === null || json === undefined) return "empty body";
  if (Array.isArray(json)) {
    const first: unknown = json[0];
    const keys =
      first && typeof first === "object" ? Object.keys(first as object).slice(0, 8).join(",") : "";
    return `array[${json.length}]${keys ? ` first-item keys: ${keys}` : ""}`;
  }
  if (typeof json === "object") {
    const o = json as Record<string, unknown>;
    const parts = Object.keys(o)
      .slice(0, 8)
      .map((k) => (Array.isArray(o[k]) ? `${k}:array[${(o[k] as unknown[]).length}]` : k));
    return `object keys: ${parts.join(", ")}`;
  }
  return typeof json;
}
function lanesOf(json: unknown): number[] {
  if (!json || typeof json !== "object") return [];
  const lanes = (json as { Lanes?: Array<{ LaneNumber?: unknown }> }).Lanes;
  if (!Array.isArray(lanes)) return [];
  return lanes.map((l) => Number(l?.LaneNumber)).filter((n) => Number.isFinite(n));
}

/* ------------------------------------------------------------------ */
/*  Neon config — offer/option ids ALWAYS come from the DB             */
/* ------------------------------------------------------------------ */

interface ExperienceOffer {
  slug: string;
  kind: string; // 'kbf' | 'open' | 'hourly'
  isVip: boolean;
  daysOfWeek: number[];
  qamfWebOfferId: number;
  qamfOptionType: string | null; // 'Game' | 'Time' | 'Unlimited'
  qamfOptionId: number | null;
}
interface DurationOption {
  slug: string;
  qamfOptionId: number;
  minutes: number;
  label: string;
  multiplier: number;
}
interface CenterConfig {
  centerCode: string;
  offers: ExperienceOffer[];
  durations: DurationOption[];
}

type SqlClient = ReturnType<typeof neon>;
let sqlClient: SqlClient | null = null;
function getSql(): SqlClient {
  if (sqlClient) return sqlClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL not set — offer/option ids must be read from Neon (never hardcoded; Naples ids differ from Fort Myers).",
    );
    process.exit(1);
  }
  sqlClient = neon(url);
  return sqlClient;
}

function toIntArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (typeof v === "string") {
    return v
      .replace(/[{}]/g, "")
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  }
  return [];
}

const centerConfigCache = new Map<string, CenterConfig>();

async function loadCenterConfig(centerCode: string): Promise<CenterConfig> {
  const cached = centerConfigCache.get(centerCode);
  if (cached) return cached;
  const sql = getSql();
  const offerRows = (await sql`
    SELECT e.slug, e.kind, e.is_vip, e.days_of_week,
           eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id
    FROM bowling_experience_offers eo
    JOIN bowling_experiences e ON e.id = eo.experience_id
    WHERE eo.center_code = ${centerCode} AND eo.is_active = TRUE AND e.is_active = TRUE
    ORDER BY e.slug
  `) as unknown as Array<Record<string, unknown>>;
  const durRows = (await sql`
    SELECT e.slug, d.qamf_option_id, d.duration_minutes, d.label, d.square_multiplier
    FROM bowling_experience_duration_options d
    JOIN bowling_experiences e ON e.id = d.experience_id
    WHERE d.center_code = ${centerCode}
    ORDER BY e.slug, d.sort_order
  `) as unknown as Array<Record<string, unknown>>;

  const cfg: CenterConfig = {
    centerCode,
    offers: offerRows.map((r) => ({
      slug: String(r.slug),
      kind: String(r.kind),
      isVip: r.is_vip === true,
      daysOfWeek: toIntArray(r.days_of_week),
      qamfWebOfferId: Number(r.qamf_web_offer_id),
      qamfOptionType: r.qamf_option_type === null || r.qamf_option_type === undefined ? null : String(r.qamf_option_type),
      qamfOptionId: r.qamf_option_id === null || r.qamf_option_id === undefined ? null : Number(r.qamf_option_id),
    })),
    durations: durRows.map((r) => ({
      slug: String(r.slug),
      qamfOptionId: Number(r.qamf_option_id),
      minutes: Number(r.duration_minutes),
      label: String(r.label),
      multiplier: Number(r.square_multiplier),
    })),
  };
  centerConfigCache.set(centerCode, cfg);
  return cfg;
}

function durationsFor(cfg: CenterConfig, slug: string): DurationOption[] {
  return cfg.durations.filter((d) => d.slug === slug).sort((a, b) => a.minutes - b.minutes);
}

/** Pick the probe experience: --offer slug when given, else the center's VIP
 *  hourly experience matching the date's weekday (vip-mon-thur / vip-fri-sun). */
function resolveExperience(cfg: CenterConfig, opts: { dow: number; slug?: string; vip?: boolean }): ExperienceOffer {
  if (opts.slug) {
    const found = cfg.offers.find((o) => o.slug === opts.slug);
    if (!found) {
      throw new Error(
        `--offer "${opts.slug}" not found for center_code=${cfg.centerCode}. Known slugs: ${cfg.offers.map((o) => o.slug).join(", ")}`,
      );
    }
    if (found.daysOfWeek.length > 0 && !found.daysOfWeek.includes(opts.dow)) {
      console.log(
        `WARNING: ${found.slug} days_of_week=[${found.daysOfWeek.join(",")}] does not include ${DOW_NAMES[opts.dow]} — QAMF may not list it that day.`,
      );
    }
    return found;
  }
  const vip = opts.vip ?? true;
  const matches = cfg.offers
    .filter((o) => o.kind === "hourly" && o.isVip === vip && (o.daysOfWeek.length === 0 || o.daysOfWeek.includes(opts.dow)))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (matches.length === 0) {
    throw new Error(
      `No ${vip ? "VIP" : "regular"} hourly experience covers ${DOW_NAMES[opts.dow]} at center_code=${cfg.centerCode}. Pass --offer <slug>. Known slugs: ${cfg.offers.map((o) => o.slug).join(", ")}`,
    );
  }
  if (matches.length > 1) {
    console.log(`note: multiple ${vip ? "VIP" : "regular"} hourly matches (${matches.map((m) => m.slug).join(", ")}) — using ${matches[0].slug}`);
  }
  return matches[0];
}

function dbMinutesMap(cfg: CenterConfig, exp: ExperienceOffer): Map<number, number> {
  const map = new Map<number, number>();
  for (const d of durationsFor(cfg, exp.slug)) map.set(d.qamfOptionId, d.minutes);
  return map;
}

/* ------------------------------------------------------------------ */
/*  Hold state file — crash-safe ledger of every reservation we create */
/* ------------------------------------------------------------------ */

interface ProbeHold {
  reservationId: string;
  centerId: number;
  bookedAt: string;
  optionId: number;
  title: string;
  createdAt: string;
}

function loadHoldState(): ProbeHold[] {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { holds?: ProbeHold[] };
    return Array.isArray(parsed.holds) ? parsed.holds : [];
  } catch {
    return [];
  }
}
function saveHoldState(holds: ProbeHold[]): void {
  writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), holds }, null, 2));
}
function trackHold(h: ProbeHold): void {
  const holds = loadHoldState();
  holds.push(h);
  saveHoldState(holds); // written IMMEDIATELY so cleanup finds it after a crash
}
function untrackHold(reservationId: string): void {
  saveHoldState(loadHoldState().filter((h) => h.reservationId !== reservationId));
}

/** Create a Temporary probe hold. Title is always PROBE_TITLE, status is never
 *  Confirmed (we never PATCH /status), and the id is tracked in the state file
 *  the moment QAMF returns it. */
async function createProbeHold(opts: {
  centerId: number;
  offerId: number;
  optionId: number;
  bookedAt: string;
  players: number;
  label: string;
}): Promise<{ res: QamfResult; reservationId: string | null }> {
  const res = await qamfRaw({
    centerId: opts.centerId,
    method: "POST",
    path: `/centers/${opts.centerId}/reservations`,
    body: {
      BookedAt: opts.bookedAt,
      Title: PROBE_TITLE,
      Notes: `qamf-duration-probe ${opts.label}`,
      WebOffer: {
        Id: opts.offerId,
        Options: { Time: [{ Id: opts.optionId }] },
        Services: ["BookForLater"],
      },
      TotalPlayers: opts.players,
    },
    label: `createReservation ${opts.label}`,
  });
  let reservationId: string | null = null;
  if (res.ok && res.json && typeof res.json === "object") {
    const id = (res.json as { Id?: unknown }).Id;
    if (id !== undefined && id !== null) reservationId = String(id);
  }
  if (reservationId) {
    trackHold({
      reservationId,
      centerId: opts.centerId,
      bookedAt: opts.bookedAt,
      optionId: opts.optionId,
      title: PROBE_TITLE,
      createdAt: new Date().toISOString(),
    });
  }
  return { res, reservationId };
}

async function deleteProbeHold(centerId: number, reservationId: string): Promise<QamfResult> {
  const res = await qamfRaw({
    centerId,
    method: "DELETE",
    path: `/centers/${centerId}/reservations/${reservationId}`,
    label: `deleteReservation ${reservationId}`,
  });
  if (res.ok || res.status === 404) untrackHold(reservationId);
  return res;
}

function printWriteWarning(args: Args): void {
  const meta = CENTER_META[args.center];
  hr("!");
  console.log("WRITE-PATH PROBE: creates Temporary reservations at a LIVE center.");
  console.log(`Target: ${meta.label} (${args.center}) on ${args.date} (${DOW_NAMES[dowOf(args.date)]}) around ${minLabel(args.timeMinutes)}.`);
  console.log("Recommended: Naples (3148) on a QUIET FUTURE WEEKDAY. Never run against");
  console.log("same-day evening slots — real guests are booking those right now.");
  console.log(`Every hold: Title "${PROBE_TITLE}", Temporary status (never`);
  console.log(`Confirmed), tracked in ${STATE_FILE},`);
  console.log("deleted on exit. QAMF's ~10-min Temporary TTL is the crash backstop.");
  if (args.date === todayYmd()) {
    console.log("CAUTION: --date is TODAY. Prefer a future weekday.");
  }
  hr("!");
  console.log("Proceeding in 3 seconds — Ctrl-C to abort.\n");
}

/* ------------------------------------------------------------------ */
/*  P1 baseline — weboffers census vs DB duration-option map           */
/* ------------------------------------------------------------------ */

async function cmdBaseline(_args: Args): Promise<void> {
  header("P1 BASELINE — QAMF weboffers census vs DB duration-option map (both centers)");
  for (const centerId of [9172, 3148]) {
    const meta = CENTER_META[centerId];
    const cfg = await loadCenterConfig(meta.centerCode);
    const res = await qamfRaw({
      centerId,
      method: "GET",
      path: `/centers/${centerId}/weboffers`,
      label: `weboffers ${meta.label}`,
    });
    console.log(`\n--- ${meta.label} (center ${centerId}, ${meta.centerCode}) ---`);
    console.log(`GET /centers/${centerId}/weboffers -> ${res.status} (${res.ms} ms)`);
    if (!res.ok) {
      console.log(`  BODY: ${res.text.slice(0, 300)}`);
      continue;
    }
    const offers = unwrapWebOffers(res.json);
    const timeOffers = offers.filter((o) => (o.Options?.Time?.length ?? 0) > 0);
    console.log(`${offers.length} offers total, ${timeOffers.length} with Time options`);

    let minutesPopulated = 0;
    let minutesTotal = 0;
    const qamfTimeIdsByOffer = new Map<string, number[]>();

    for (const o of timeOffers) {
      const tOpts = o.Options?.Time ?? [];
      qamfTimeIdsByOffer.set(String(o.Id), tOpts.map((t) => Number(t.Id)));
      minutesTotal += tOpts.length;
      minutesPopulated += tOpts.filter((t) => typeof t.Minutes === "number" && t.Minutes > 0).length;

      const dbExps = cfg.offers.filter((e) => String(e.qamfWebOfferId) === String(o.Id));
      const mappedIds = new Set<number>();
      for (const e of dbExps) {
        if (e.qamfOptionId !== null) mappedIds.add(e.qamfOptionId);
        for (const d of durationsFor(cfg, e.slug)) mappedIds.add(d.qamfOptionId);
      }

      console.log(`\n  offer ${padr(String(o.Id), 5)} "${o.Title ?? ""}" enabled=${String(o.IsEnabled)}`);
      console.log(
        `    QAMF Time options (response order): ${tOpts
          .map((t) => `${t.Id} Minutes=${typeof t.Minutes === "number" ? t.Minutes : "(unset)"}`)
          .join(" | ")}`,
      );
      if (dbExps.length === 0) {
        console.log("    DB experiences: (none — offer is not mapped in bowling_experience_offers)");
      } else {
        console.log(`    DB experiences: ${dbExps.map((e) => e.slug).join(", ")}`);
        for (const e of dbExps) {
          const durs = durationsFor(cfg, e.slug);
          if (durs.length > 0) {
            console.log(
              `      ${e.slug} durations: ${durs
                .map((d) => `opt ${d.qamfOptionId} = ${d.minutes} min x${d.multiplier} "${d.label}"`)
                .join(" | ")}`,
            );
          } else if (e.qamfOptionId !== null) {
            console.log(`      ${e.slug}: fixed base option ${e.qamfOptionId} (${e.qamfOptionType ?? "?"}), no duration rows`);
          }
        }
      }
      const unmapped = tOpts.filter((t) => !mappedIds.has(Number(t.Id)));
      if (unmapped.length > 0) {
        console.log(
          `    UNMAPPED in DB: ${unmapped
            .map((t) => {
              const is60 = t.Minutes === 60 ? " <-- 60-min option unmapped (owner question, plan sec 13.2)" : "";
              return `${t.Id} (Minutes=${typeof t.Minutes === "number" ? t.Minutes : "unset"})${is60}`;
            })
            .join(", ")}`,
        );
      }
    }
    console.log(`\n  Minutes populated on ${minutesPopulated}/${minutesTotal} QAMF Time options`);

    // DB -> QAMF orphan check: duration rows whose option id QAMF does not list.
    const orphans: string[] = [];
    for (const d of cfg.durations) {
      const exp = cfg.offers.find((e) => e.slug === d.slug);
      if (!exp) {
        orphans.push(`${d.slug} opt ${d.qamfOptionId} (${d.minutes} min): experience has no offer row`);
        continue;
      }
      const qIds = qamfTimeIdsByOffer.get(String(exp.qamfWebOfferId));
      if (!qIds) {
        orphans.push(`${d.slug} opt ${d.qamfOptionId} (${d.minutes} min): offer ${exp.qamfWebOfferId} not in QAMF Time-offer census`);
      } else if (!qIds.includes(d.qamfOptionId)) {
        orphans.push(`${d.slug} opt ${d.qamfOptionId} (${d.minutes} min): NOT in offer ${exp.qamfWebOfferId}'s Time list [${qIds.join(",")}]`);
      }
    }
    console.log(
      orphans.length === 0
        ? "  DB duration options missing from QAMF response: none"
        : `  DB duration options missing from QAMF response:\n    ${orphans.join("\n    ")}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  P2 near-close — is the 120 option dropped when it cannot fit?      */
/* ------------------------------------------------------------------ */

async function cmdNearClose(args: Args): Promise<void> {
  header("P2 NEAR-CLOSE — is the 120-min option dropped when it cannot fit before close?");
  const meta = CENTER_META[args.center];
  const cfg = await loadCenterConfig(meta.centerCode);
  const dow = dowOf(args.date);
  const close = closeHourFor(dow);
  const exp = resolveExperience(cfg, { dow, slug: args.offer });
  const dbMins = dbMinutesMap(cfg, exp);
  const d120 = durationsFor(cfg, exp.slug).find((d) => d.minutes === 120);

  console.log(`center ${meta.label} (${args.center}) | ${args.date} (${DOW_NAMES[dow]}) close ${minLabel(close * 60)}`);
  console.log(`offer ${exp.slug} (QAMF ${exp.qamfWebOfferId}) | DB durations: ${durationsFor(cfg, exp.slug).map((d) => `${d.minutes} -> opt ${d.qamfOptionId}`).join(", ") || "(none)"}\n`);
  if (!d120) console.log("note: no 120-min duration row in DB for this experience — presence check below is by option list only.\n");

  for (const back of [75, 30]) {
    const probeMin = close * 60 - back;
    const iso = isoAt(args.date, probeMin);
    const res = await searchPoint(args.center, iso, args.players, `near-close close-${back}`);
    if (!res.ok) {
      console.log(`close-${back} (${minLabel(probeMin)}) -> ${res.status} (${res.ms} ms) BODY: ${res.text.slice(0, 200)}`);
      continue;
    }
    const entry = entriesFor(res, exp.qamfWebOfferId)[0];
    if (!entry) {
      console.log(`close-${back} (${minLabel(probeMin)}): offer ABSENT from response (${res.ms} ms)`);
      continue;
    }
    console.log(`close-${back} (${minLabel(probeMin)}): offer PRESENT (${res.ms} ms)`);
    console.log(`  Options.Time: ${describeTimeOptions(entry, dbMins)}`);
    if (d120) {
      const listed = timeIds(entry).includes(d120.qamfOptionId);
      console.log(
        `  120-min option (${d120.qamfOptionId}) listed: ${listed ? "YES" : "NO"} — a 120-min start here would end ${minLabel(probeMin + 120)} vs close ${minLabel(close * 60)}`,
      );
    }
  }
  console.log(
    "\nInterpretation: 120 still listed at close-30/close-75 => QAMF does NOT close-filter Options.Time (expected weak H3-negative; our slotExceedsClose stays load-bearing). 120 dropped => QAMF is duration-aware even point-in-time — confirm with `blocked`.",
  );
}

/* ------------------------------------------------------------------ */
/*  P3 list-res — reservations-list endpoint discovery                 */
/* ------------------------------------------------------------------ */

async function cmdListRes(args: Args): Promise<void> {
  header("P3 LIST-RES — does a trustworthy reservations-list endpoint exist?");
  const c = args.center;
  const startIso = isoAt(args.date, OPEN_HOUR * 60);
  const endIso = isoAt(args.date, 28 * 60); // 04:00 next day — covers the 24-26h tail
  console.log(`center ${CENTER_META[c].label} (${c}) | range ${startIso} .. ${endIso}`);

  for (const ver of [API_VER, "1.2", "1.3"]) {
    console.log(`\napi-version ${ver}:`);
    const attempts: Array<{ label: string; method: "GET" | "POST"; path: string; body?: unknown }> = [
      { label: "GET  /reservations", method: "GET", path: `/centers/${c}/reservations` },
      {
        label: "GET  /reservations?from&to",
        method: "GET",
        path: `/centers/${c}/reservations?from=${enc(startIso)}&to=${enc(endIso)}`,
      },
      {
        label: "GET  /reservations?startAt&endAt",
        method: "GET",
        path: `/centers/${c}/reservations?startAt=${enc(startIso)}&endAt=${enc(endIso)}`,
      },
      {
        label: "POST /reservations/search",
        method: "POST",
        path: `/centers/${c}/reservations/search`,
        body: { Filter: { BookedAtRange: { StartAt: startIso, EndAt: endIso } } },
      },
    ];
    for (const at of attempts) {
      const res = await qamfRaw({ centerId: c, method: at.method, path: at.path, body: at.body, apiVersion: ver, label: `list-res ${at.label} @${ver}` });
      console.log(
        `  ${padr(at.label, 34)} -> ${padr(res.status, 3)} (${res.ms} ms)  ${res.ok ? shapeSummary(res.json) : `BODY: ${res.text.slice(0, 160)}`}`,
      );
    }
  }
  console.log(
    "\nIf any attempt returned 2xx with a reservation array: cross-check it against Conqueror on a day WITH walk-ins/POS bookings — branch E is only viable if the list reflects ALL occupancy, not just API-created reservations (plan sec 7 P3).",
  );
}

/* ------------------------------------------------------------------ */
/*  P4 window — StartAt != EndAt semantics                             */
/* ------------------------------------------------------------------ */

async function cmdWindow(args: Args): Promise<void> {
  header("P4 WINDOW — searchAvailability semantics when EndAt != StartAt");
  const meta = CENTER_META[args.center];
  const cfg = await loadCenterConfig(meta.centerCode);
  const dow = dowOf(args.date);
  const exp = resolveExperience(cfg, { dow, slug: args.offer });
  const startIso = isoAt(args.date, args.timeMinutes);
  console.log(`center ${meta.label} (${args.center}) | offer ${exp.slug} (QAMF ${exp.qamfWebOfferId}) | StartAt ${startIso}\n`);

  let sawSeries = false;
  for (const span of [
    { label: "+30m", minutes: 30 },
    { label: "+2h", minutes: 120 },
    { label: "+4h", minutes: 240 },
  ]) {
    const endIso = isoAt(args.date, args.timeMinutes + span.minutes);
    const res = await searchAvail({
      centerId: args.center,
      startAt: startIso,
      endAt: endIso,
      players: args.players,
      label: `window ${span.label}`,
    });
    if (!res.ok) {
      console.log(`${padr(span.label, 5)} -> ${res.status} (${res.ms} ms)  BODY: ${res.text.slice(0, 300)}`);
      continue;
    }
    const all = availabilities(res);
    const msVals = distinctBookedAtMs(all);
    const gran = granularityMinutes(msVals);
    if (msVals.length > 1) sawSeries = true;
    console.log(
      `${padr(span.label, 5)} -> ${res.status} (${res.ms} ms)  entries=${all.length}  distinct BookedAt=${msVals.length}  granularity=${gran === null ? "n/a" : `${gran} min`}  target-offer entries=${entriesFor(res, exp.qamfWebOfferId).length}`,
    );
    console.log(`       BookedAt (ET): ${msVals.slice(0, 12).map(fmtClockEt).join(", ")}${msVals.length > 12 ? ", ..." : ""}`);
  }
  console.log(
    `\nInterpretation: ${
      sawSeries
        ? "window search returns a TIME SERIES -> branch C candidate. Confirm feasibility-awareness with `blocked` step [5] before choosing C."
        : "single BookedAt per response -> point semantics only; window search adds nothing (branch C unlikely)."
    }`,
  );
}

/* ------------------------------------------------------------------ */
/*  P5 filter — is WebOffer.Id / Options.Time honored?                 */
/* ------------------------------------------------------------------ */

async function cmdFilter(args: Args): Promise<void> {
  header("P5 FILTER — is WebOffer.Id / Options.Time honored by availability search?");
  const meta = CENTER_META[args.center];
  const cfg = await loadCenterConfig(meta.centerCode);
  const dow = dowOf(args.date);
  const exp = resolveExperience(cfg, { dow, slug: args.offer });
  const durs = durationsFor(cfg, exp.slug);
  if (durs.length === 0) throw new Error(`No duration rows for ${exp.slug} at ${meta.centerCode} — pass --offer of an hourly experience.`);
  const dbMins = dbMinutesMap(cfg, exp);
  let d120 = durs.find((d) => d.minutes === 120);
  if (!d120) {
    d120 = durs[durs.length - 1];
    console.log(`note: no 120-min duration row for ${exp.slug} — using longest (${d120.minutes} min, opt ${d120.qamfOptionId}) instead.\n`);
  }
  const startIso = isoAt(args.date, args.timeMinutes);
  console.log(`center ${meta.label} (${args.center}) | offer ${exp.slug} (QAMF ${exp.qamfWebOfferId}) | T = ${startIso}\n`);

  const variants: Array<{ label: string; offerId?: number; timeOptionIds?: number[] }> = [
    { label: "control (Services only)" },
    { label: "WebOffer.Id", offerId: exp.qamfWebOfferId },
    { label: `WebOffer.Id + Options.Time [{Id:${d120.qamfOptionId}}]`, offerId: exp.qamfWebOfferId, timeOptionIds: [d120.qamfOptionId] },
  ];
  const results: QamfResult[] = [];
  for (const v of variants) {
    const res = await searchPoint(args.center, startIso, args.players, `filter ${v.label}`, v.offerId, v.timeOptionIds);
    results.push(res);
    if (!res.ok) {
      console.log(`${v.label}\n  -> ${res.status} (${res.ms} ms)  BODY: ${res.text.slice(0, 400)}\n`);
      continue;
    }
    const offerIds = distinctOfferIds(res);
    const entry = entriesFor(res, exp.qamfWebOfferId)[0];
    console.log(`${v.label}`);
    console.log(`  -> ${res.status} (${res.ms} ms)  entries=${availabilities(res).length}  distinct offers=${offerIds.length} [${offerIds.slice(0, 12).join(",")}${offerIds.length > 12 ? ",..." : ""}]`);
    console.log(`  target offer: ${entry ? `PRESENT, Options.Time: ${describeTimeOptions(entry, dbMins)}` : "ABSENT"}\n`);
  }

  const [ctrl, byId, byIdOpt] = results;
  if (ctrl.ok && byId.ok) {
    const narrowed = distinctOfferIds(byId).length < distinctOfferIds(ctrl).length;
    console.log(
      `Verdict Id filter: ${narrowed ? "NARROWS the response (honored — contradicts the route comment, re-verify)" : "ignored — same offer spread as control (matches availability route comment)"}`,
    );
  }
  if (byIdOpt.status === 400) {
    console.log("Verdict Options.Time filter: 400 — QAMF rejects Options in the availability filter.");
  } else if (byIdOpt.ok) {
    const ctrlEntry = entriesFor(ctrl, exp.qamfWebOfferId)[0];
    const optEntry = entriesFor(byIdOpt, exp.qamfWebOfferId)[0];
    if (!optEntry) {
      console.log("Verdict Options.Time filter: target offer ABSENT under the option filter at a free time — suspicious; re-run `blocked` step [4] to interpret (honored-and-infeasible vs over-filtering).");
    } else {
      const ctrlIds = ctrlEntry ? timeIds(ctrlEntry) : [];
      const optIds = timeIds(optEntry);
      const narrowedOpts = optIds.length < ctrlIds.length;
      console.log(
        `Verdict Options.Time filter: ${narrowedOpts ? `option list NARROWED (${ctrlIds.join(",")} -> ${optIds.join(",")}) — filter honored (branch B candidate; confirm with blocked step [4])` : "option list unchanged — filter ignored"}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  P6 blocked — THE decisive experiment (write, self-cleaning)        */
/* ------------------------------------------------------------------ */

async function cmdBlocked(args: Args): Promise<void> {
  header("P6 BLOCKED-WINDOW — the decisive duration-feasibility experiment (WRITES)");
  printWriteWarning(args);
  await sleep(3000);
  const t0 = Date.now();

  const meta = CENTER_META[args.center];
  const cfg = await loadCenterConfig(meta.centerCode);
  const dow = dowOf(args.date);
  const exp = resolveExperience(cfg, { dow, slug: args.offer, vip: true });
  const durs = durationsFor(cfg, exp.slug);
  const d90 = durs.find((d) => d.minutes === 90);
  const d120 = durs.find((d) => d.minutes === 120);
  if (!d90 || !d120) {
    throw new Error(
      `${exp.slug} needs BOTH a 90-min and a 120-min duration row for P6 (have: ${durs.map((d) => d.minutes).join(", ") || "none"}). Pass --offer of an hourly experience with the 90/120 pair.`,
    );
  }
  const dbMins = dbMinutesMap(cfg, exp);

  // 60-min block option census (from the live weboffers response — P1's job,
  // repeated here so `blocked` is self-sufficient). Fall back to the 90-min
  // option if no 60 exists; the blocked window then shifts to [T+90, T+180).
  const woRes = await qamfRaw({ centerId: args.center, method: "GET", path: `/centers/${args.center}/weboffers`, label: "weboffers census for block option" });
  const qOffer = unwrapWebOffers(woRes.json).find((o) => String(o.Id) === String(exp.qamfWebOfferId));
  let blockOpt: { id: number; minutes: number; source: string } | null = null;
  for (const t of qOffer?.Options?.Time ?? []) {
    const mins = typeof t.Minutes === "number" && t.Minutes > 0 ? t.Minutes : dbMins.get(Number(t.Id));
    if (mins === 60) {
      blockOpt = { id: Number(t.Id), minutes: 60, source: typeof t.Minutes === "number" ? "QAMF Minutes" : "DB map" };
      break;
    }
  }
  if (!blockOpt) {
    blockOpt = { id: d90.qamfOptionId, minutes: 90, source: "fallback: no 60-min option exists" };
    console.log("note: no 60-min option found for this offer — falling back to the 90-min option; blocked window shifts to [T+90, T+180).");
  }

  const tMin = args.timeMinutes;
  const startIso = isoAt(args.date, tMin);
  const blockStartMin = tMin + 90;
  const blockIso = isoAt(args.date, blockStartMin);
  const blockEndMin = blockStartMin + blockOpt.minutes;

  console.log(`offer ${exp.slug} (QAMF ${exp.qamfWebOfferId}) | 90-min opt ${d90.qamfOptionId} | 120-min opt ${d120.qamfOptionId}`);
  console.log(`block option: ${blockOpt.id} (${blockOpt.minutes} min, ${blockOpt.source})`);
  console.log(`T = ${startIso} | blocked window [${minLabel(blockStartMin)}, ${minLabel(blockEndMin)}) via holds at ${blockIso}\n`);

  // [0] pre-checks: the offer must be free at T and T+90 before we block.
  const pre0 = await searchPoint(args.center, startIso, args.players, "pre-block control at T");
  const preEntry = entriesFor(pre0, exp.qamfWebOfferId)[0];
  const pre90 = await searchPoint(args.center, blockIso, args.players, "pre-block control at T+90");
  const pre90Present = entriesFor(pre90, exp.qamfWebOfferId).length > 0;
  const pre120Listed = preEntry ? timeIds(preEntry).includes(d120.qamfOptionId) : false;
  console.log(`[0] pre-block: offer at T ${preEntry ? "PRESENT" : "ABSENT"} (Options.Time: ${preEntry ? describeTimeOptions(preEntry, dbMins) : "-"}), at T+90 ${pre90Present ? "PRESENT" : "ABSENT"}`);
  if (!preEntry || !pre90Present) {
    throw new Error("Pre-block probes show the offer is not free at T and T+90 — pick a quieter date/time; saturating a non-free window proves nothing.");
  }
  if (!pre120Listed) {
    console.log("    WARNING: 120-min option not listed at T even before the block — H3/H2 comparisons will be confounded.");
  }

  const createdIds: string[] = [];
  const findings: Array<[string, string]> = [];
  let satFail: QamfResult | null = null;
  let saturationConfirmed = false;
  let h1 = false;
  let h2 = false;
  let h3 = false;

  try {
    // [1] Saturate the lane group at T+90 until createReservation fails.
    console.log(`\n[1] saturating with ${blockOpt.minutes}-min Temporary holds at ${blockIso} (cap ${MAX_SATURATION_HOLDS}) ...`);
    for (let i = 1; i <= MAX_SATURATION_HOLDS; i++) {
      const { res, reservationId } = await createProbeHold({
        centerId: args.center,
        offerId: exp.qamfWebOfferId,
        optionId: blockOpt.id,
        bookedAt: blockIso,
        players: args.players,
        label: `P6 saturation #${i}`,
      });
      if (res.ok && reservationId) {
        createdIds.push(reservationId);
        console.log(`    hold #${i}: ${reservationId} lanes=[${lanesOf(res.json).join(",")}] (${res.ms} ms)`);
      } else {
        satFail = res;
        console.log(`    create #${i} FAILED -> ${res.status} (${res.ms} ms)`);
        console.log(`    VERBATIM BODY: ${res.text}`);
        break;
      }
    }
    if (!satFail) {
      console.log(`    WARNING: hit the ${MAX_SATURATION_HOLDS}-hold cap without a failure — lane group larger than the cap, or holds are not blocking. Results below are INCONCLUSIVE.`);
    }
    findings.push(["saturation", satFail ? `${createdIds.length} holds until ${satFail.status} (group size <= ${createdIds.length})` : `NOT reached (cap ${MAX_SATURATION_HOLDS})`]);

    // [2] (a) control probe at T+90: offer must be ABSENT.
    const ctl = await searchPoint(args.center, blockIso, args.players, "blocked control at T+90");
    const ctlAbsent = entriesFor(ctl, exp.qamfWebOfferId).length === 0;
    saturationConfirmed = satFail !== null && ctlAbsent;
    console.log(`\n[2] (a) control at T+90: offer ${ctlAbsent ? "ABSENT — saturation confirmed" : "STILL PRESENT — saturation NOT confirmed"}`);
    findings.push(["(a) offer absent at T+90", ctlAbsent ? "YES" : "NO"]);

    // [3] (b) H3: point probe at T — does the 120 option disappear?
    const h3Res = await searchPoint(args.center, startIso, args.players, "H3 point probe at T");
    const h3Entry = entriesFor(h3Res, exp.qamfWebOfferId)[0];
    const h3Ids = h3Entry ? timeIds(h3Entry) : [];
    const still120 = h3Ids.includes(d120.qamfOptionId);
    h3 = pre120Listed && !!h3Entry && !still120;
    console.log(`\n[3] (b) H3 point probe at T: offer ${h3Entry ? "PRESENT" : "ABSENT"}`);
    if (h3Entry) console.log(`    full Options.Time: ${describeTimeOptions(h3Entry, dbMins)}`);
    console.log(`    120-min option (${d120.qamfOptionId}): ${still120 ? "still listed" : h3Entry ? "GONE" : "n/a (offer hidden entirely)"}`);
    if (!h3Entry) console.log("    note: QAMF hid the WHOLE offer at T (90 would fit) — over-strict duration awareness; verify with step [5] create-90.");
    findings.push(["(b) H3 120 dropped at T", h3 ? "YES -> branch A" : h3Entry ? "NO (still listed)" : "offer hidden entirely"]);

    // [4] (c) H2: Id + Options.Time filtered probes at T (120 then 90 control).
    const h2Res120 = await searchPoint(args.center, startIso, args.players, "H2 filtered probe at T (120)", exp.qamfWebOfferId, [d120.qamfOptionId]);
    const h2Absent120 = h2Res120.ok && entriesFor(h2Res120, exp.qamfWebOfferId).length === 0;
    const h2Res90 = await searchPoint(args.center, startIso, args.players, "H2 filtered probe at T (90)", exp.qamfWebOfferId, [d90.qamfOptionId]);
    const h2Present90 = h2Res90.ok && entriesFor(h2Res90, exp.qamfWebOfferId).length > 0;
    h2 = h2Absent120 && h2Present90;
    console.log(`\n[4] (c) H2 Id+Options.Time filtered probes at T:`);
    console.log(`    with 120 opt -> ${h2Res120.status}: offer ${h2Absent120 ? "ABSENT/empty" : "present"}${h2Res120.status === 400 ? ` BODY: ${h2Res120.text.slice(0, 200)}` : ""}`);
    console.log(`    with  90 opt -> ${h2Res90.status}: offer ${h2Present90 ? "present" : "ABSENT"}`);
    findings.push(["(c) H2 filter honored", h2 ? "YES -> branch B" : "NO"]);

    // [5] (d) H1: window probe [T, T+150] — does the series reflect the block?
    const winEndMin = tMin + 150;
    const winRes = await searchAvail({
      centerId: args.center,
      startAt: startIso,
      endAt: isoAt(args.date, winEndMin),
      players: args.players,
      label: "H1 window probe [T, T+150]",
    });
    const winMs = distinctBookedAtMs(entriesFor(winRes, exp.qamfWebOfferId));
    const tMs = Date.parse(startIso);
    const blockStartMs = Date.parse(blockIso);
    const winEndMs = Date.parse(isoAt(args.date, winEndMin));
    const blockEndMs = Math.min(Date.parse(isoAt(args.date, blockEndMin)), winEndMs);
    const inFree = winMs.filter((m) => m >= tMs && m < blockStartMs).length;
    const inBlocked = winMs.filter((m) => m >= blockStartMs && m < blockEndMs).length;
    h1 = winRes.ok && winMs.length > 1 && inFree > 0 && inBlocked === 0;
    console.log(`\n[5] (d) H1 window probe [T, T+150] -> ${winRes.status} (${winRes.ms} ms)`);
    console.log(`    offer BookedAt values (ET): ${winMs.map(fmtClockEt).join(", ") || "(none)"}`);
    console.log(`    in free range [T, T+90): ${inFree} | in blocked range: ${inBlocked}`);
    findings.push(["(d) H1 window reflects block", h1 ? "YES -> branch C" : winMs.length <= 1 ? "n/a (no time series)" : "NO"]);

    // [6] (e) H4a: create at T with 120 (expect fail — capture vocabulary),
    //     then with 90 (expect success) -> DELETE -> confirm instant release.
    console.log(`\n[6] (e) H4a createReservation at T with the 120-min option (expect FAILURE):`);
    const c120 = await createProbeHold({
      centerId: args.center,
      offerId: exp.qamfWebOfferId,
      optionId: d120.qamfOptionId,
      bookedAt: startIso,
      players: args.players,
      label: "P6 H4a 120-min at T",
    });
    console.log(`    -> ${c120.res.status} (${c120.res.ms} ms)`);
    console.log(`    VERBATIM BODY: ${c120.res.text}`);
    findings.push(["(e) create 120 at T", c120.res.ok ? "SUCCEEDED (ANOMALY — block not effective?)" : `failed ${c120.res.status} (H4a vocabulary captured)`]);
    if (c120.reservationId) {
      console.log("    ANOMALY: the 120-min create SUCCEEDED — deleting it; treat the run as inconclusive.");
      const del = await deleteProbeHold(args.center, c120.reservationId);
      if (!(del.ok || del.status === 404)) createdIds.push(c120.reservationId);
      saturationConfirmed = false;
    }

    console.log(`    H4a createReservation at T with the 90-min option (expect SUCCESS):`);
    const c90 = await createProbeHold({
      centerId: args.center,
      offerId: exp.qamfWebOfferId,
      optionId: d90.qamfOptionId,
      bookedAt: startIso,
      players: args.players,
      label: "P6 H4a 90-min at T",
    });
    console.log(`    -> ${c90.res.status} (${c90.res.ms} ms)${c90.res.ok ? ` id=${c90.reservationId}` : ` VERBATIM BODY: ${c90.res.text}`}`);
    let instantRelease = false;
    if (c90.reservationId) {
      const del = await deleteProbeHold(args.center, c90.reservationId);
      console.log(`    DELETE ${c90.reservationId} -> ${del.status} (${del.ms} ms)`);
      if (!(del.ok || del.status === 404)) createdIds.push(c90.reservationId);
      const re = await searchPoint(args.center, startIso, args.players, "post-delete re-probe at T");
      instantRelease = entriesFor(re, exp.qamfWebOfferId).length > 0;
      console.log(`    re-probe at T: offer ${instantRelease ? "PRESENT — instant release confirmed" : "ABSENT — release NOT instant (or T got taken)"}`);
    }
    findings.push(["(e) create 90 at T + instant release", c90.res.ok ? (instantRelease ? "YES" : "created but release not instant") : `create failed ${c90.res.status}`]);

    // [7] (f) lane-group disjointness: probe a REGULAR offer during the block.
    console.log(`\n[7] (f) lane-group disjointness — regular offer during the block:`);
    try {
      const reg = resolveExperience(cfg, { dow, vip: false });
      const regRes = await searchPoint(args.center, blockIso, args.players, "disjointness probe (regular offer) at T+90");
      const regPresent = entriesFor(regRes, reg.qamfWebOfferId).length > 0;
      console.log(`    regular offer ${reg.slug} (QAMF ${reg.qamfWebOfferId}) at T+90: ${regPresent ? "PRESENT -> VIP/regular lane groups DISJOINT" : "ABSENT -> shared lanes (rerun P6 on the regular offer after hours)"}`);
      findings.push(["(f) regular offer during block", regPresent ? "PRESENT -> groups disjoint" : "ABSENT -> shared lanes"]);
    } catch (err) {
      console.log(`    skipped: ${errMsg(err)}`);
      findings.push(["(f) regular offer during block", "skipped (no regular hourly match)"]);
    }
  } finally {
    if (args.noCleanup) {
      console.log(`\n--no-cleanup: leaving the block IN PLACE for manual wizard testing.`);
      console.log(`Hold ids (also tracked in ${STATE_FILE}):`);
      for (const id of createdIds) console.log(`  ${id}`);
      console.log("QAMF expires Temporary holds after ~10 min. Run the `cleanup` subcommand to delete early.");
    } else {
      console.log(`\n[cleanup] deleting ${createdIds.length} probe hold(s) ...`);
      for (const id of createdIds) {
        const res = await deleteProbeHold(args.center, id);
        console.log(`  DELETE ${id} -> ${res.status}${res.ok || res.status === 404 ? "" : `  BODY: ${res.text.slice(0, 200)}`}`);
      }
      const verify = await searchPoint(args.center, blockIso, args.players, "post-cleanup verify at T+90");
      const freed = entriesFor(verify, exp.qamfWebOfferId).length > 0;
      console.log(`  re-probe at T+90: offer ${freed ? "PRESENT again — window released" : "STILL ABSENT — verify in Conqueror / run `cleanup` again"}`);
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`\nElapsed: ${elapsed}s (whole run must stay inside the ~600s Temporary-hold TTL${elapsed > 510 ? " — EXCEEDED SAFE MARGIN, earliest holds may have expired mid-run" : ""})`);
  }

  // Summary -> design-branch mapping (plan sec 5 outcome table).
  console.log("");
  hr("-");
  console.log("P6 SUMMARY — observations -> design branches");
  hr("-");
  for (const [k, v] of findings) console.log(`  ${padr(k, 38)} ${v}`);
  if (!saturationConfirmed) {
    console.log("\n  RESULT: INCONCLUSIVE — saturation was not confirmed (see (a)/(e)).");
    console.log("  Do not map to a branch; re-run on a quieter slot or a smaller lane group.");
  } else {
    const branch = h3 ? "A" : h2 ? "B" : h1 ? "C" : "D";
    const branchDesc: Record<string, string> = {
      A: "trust QAMF's point-in-time Options.Time; keep slotExceedsClose as belt-and-braces",
      B: "WebOffer.Id + Options.Time honored -> targeted verification probes for non-shortest options",
      C: "window search is feasibility-aware -> replace N point probes with 1-4 chunked window calls",
      D: "no QAMF duration signal -> windowed necessary-condition filter over a 15-min point-probe map",
    };
    console.log(`\n  RECOMMENDED DESIGN BRANCH: ${branch} — ${branchDesc[branch]}`);
    console.log("  (Branch E depends on P3 — see the list-res subcommand output.)");
  }
}

/* ------------------------------------------------------------------ */
/*  P7 hold-codes — error vocabulary (write, self-cleaning)            */
/* ------------------------------------------------------------------ */

async function cmdHoldCodes(args: Args): Promise<void> {
  header("P7 HOLD-CODES — double-book vs duration-infeasible error vocabulary (WRITES)");
  printWriteWarning(args);
  await sleep(3000);

  const meta = CENTER_META[args.center];
  const cfg = await loadCenterConfig(meta.centerCode);
  const dow = dowOf(args.date);
  const exp = resolveExperience(cfg, { dow, slug: args.offer, vip: true });
  const durs = durationsFor(cfg, exp.slug);
  if (durs.length === 0) throw new Error(`No duration rows for ${exp.slug} at ${meta.centerCode}.`);
  const shortest = durs[0];
  const longest = durs[durs.length - 1];

  const createdIds: string[] = [];
  try {
    // [1] Double-book attempt: two identical creates at the same free time.
    const startIso = isoAt(args.date, args.timeMinutes);
    console.log(`[1] double-book: two identical creates at ${startIso} (option ${shortest.qamfOptionId} = ${shortest.minutes} min)`);
    const first = await createProbeHold({
      centerId: args.center,
      offerId: exp.qamfWebOfferId,
      optionId: shortest.qamfOptionId,
      bookedAt: startIso,
      players: args.players,
      label: "P7 double-book #1",
    });
    console.log(`    create #1 -> ${first.res.status} (${first.res.ms} ms)${first.res.ok ? ` id=${first.reservationId} lanes=[${lanesOf(first.res.json).join(",")}]` : ""}`);
    if (!first.res.ok) console.log(`    VERBATIM BODY: ${first.res.text}`);
    if (first.reservationId) createdIds.push(first.reservationId);

    const second = await createProbeHold({
      centerId: args.center,
      offerId: exp.qamfWebOfferId,
      optionId: shortest.qamfOptionId,
      bookedAt: startIso,
      players: args.players,
      label: "P7 double-book #2",
    });
    console.log(`    create #2 -> ${second.res.status} (${second.res.ms} ms)${second.res.ok ? ` id=${second.reservationId} lanes=[${lanesOf(second.res.json).join(",")}]` : ""}`);
    if (!second.res.ok) {
      console.log(`    VERBATIM BODY: ${second.res.text}`);
    } else {
      console.log("    note: second create SUCCEEDED — the lane group had spare capacity. For the true double-book error, saturate first (`blocked --no-cleanup`, then re-run hold-codes inside the TTL).");
    }
    if (second.reservationId) createdIds.push(second.reservationId);

    // [2] Duration-infeasible attempt: longest option where its tail cannot fit.
    console.log(`\n[2] duration-infeasible: option ${longest.qamfOptionId} (${longest.minutes} min) where the tail cannot fit`);
    const liveBlock = loadHoldState()
      .filter((h) => h.centerId === args.center && Date.now() - Date.parse(h.createdAt) < 9 * 60_000)
      .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))[0];
    let infeasibleIso: string;
    if (liveBlock) {
      infeasibleIso = isoShiftMinutes(liveBlock.bookedAt, -60);
      console.log(`    reusing live blocked window from state file (block starts ${liveBlock.bookedAt}) -> attempting at ${infeasibleIso}`);
    } else {
      const close = closeHourFor(dow);
      infeasibleIso = isoAt(args.date, close * 60 - 60);
      console.log(`    no live blocked window in state file -> using near-closing slot ${infeasibleIso} (close ${minLabel(close * 60)}, only 60 min left)`);
    }
    const inf = await createProbeHold({
      centerId: args.center,
      offerId: exp.qamfWebOfferId,
      optionId: longest.qamfOptionId,
      bookedAt: infeasibleIso,
      players: args.players,
      label: "P7 duration-infeasible",
    });
    console.log(`    create -> ${inf.res.status} (${inf.res.ms} ms)`);
    console.log(`    VERBATIM BODY: ${inf.res.text}`);
    if (inf.reservationId) {
      console.log("    note: infeasible create SUCCEEDED — QAMF accepted a booking that does not fit; capture this for the guard design.");
      createdIds.push(inf.reservationId);
    }
    console.log("\nCompare the two failure bodies above: distinguishable codes let the hold route map QAMF errors to {slot_taken} vs {option_unavailable} (plan sec 8).");
  } finally {
    console.log(`\n[cleanup] deleting ${createdIds.length} probe hold(s) ...`);
    for (const id of createdIds) {
      const res = await deleteProbeHold(args.center, id);
      console.log(`  DELETE ${id} -> ${res.status} (${res.ms} ms)${res.ok || res.status === 404 ? "" : `  BODY: ${res.text.slice(0, 200)}`}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  P8 latency — concurrency envelope                                  */
/* ------------------------------------------------------------------ */

function spreadTimes(date: string, n: number): string[] {
  const start = OPEN_HOUR * 60;
  const end = closeHourFor(dowOf(date)) * 60;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = start + ((end - start) * i) / n;
    out.push(isoAt(date, Math.min(end, Math.round(raw / 15) * 15)));
  }
  return out;
}

async function cmdLatency(args: Args): Promise<void> {
  header("P8 LATENCY — concurrent point-probe envelope (read-only)");
  const meta = CENTER_META[args.center];
  console.log(`center ${meta.label} (${args.center}) | date ${args.date} | probes spread ${minLabel(OPEN_HOUR * 60)} .. ${minLabel(closeHourFor(dowOf(args.date)) * 60)}\n`);

  for (const n of [8, 16, 32]) {
    const times = spreadTimes(args.date, n);
    const started = Date.now();
    const results = await Promise.all(
      times.map((iso, i) => searchPoint(args.center, iso, args.players, `latency n=${n} #${i}`)),
    );
    const wall = Date.now() - started;
    const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
    const tally = new Map<number, number>();
    for (const r of results) tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
    const c429 = tally.get(429) ?? 0;
    const c5xx = results.filter((r) => r.status >= 500).length;
    const cNet = tally.get(0) ?? 0;
    console.log(
      `concurrency ${padr(n, 3)} wall ${padr(`${wall} ms`, 9)} p50 ${padr(`${pct(sorted, 50)} ms`, 9)} p95 ${padr(`${pct(sorted, 95)} ms`, 9)} max ${sorted[sorted.length - 1]} ms`,
    );
    console.log(
      `    statuses: ${[...tally.entries()].map(([s, c]) => `${s === 0 ? "net-err" : s}x${c}`).join(", ")}${c429 > 0 || c5xx > 0 || cNet > 0 ? "  <-- WARNING: throttling/errors at this level" : ""}`,
    );
    await sleep(1500);
  }
  console.log("\nUse the highest clean level to size the availability route's batch (currently 8, retry-once — plan sec 5 caching notes).");
}

/* ------------------------------------------------------------------ */
/*  cleanup — delete lingering probe reservations                      */
/* ------------------------------------------------------------------ */

function extractReservations(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of ["Reservations", "Items", "Data", "Results"]) {
      const v = o[k];
      if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    }
  }
  return [];
}

async function cmdCleanup(args: Args): Promise<void> {
  header("CLEANUP — delete lingering probe reservations");

  // 1. State-file holds (written by blocked/hold-codes immediately at create).
  const holds = loadHoldState();
  if (holds.length === 0) {
    console.log(`state file has no tracked holds (${STATE_FILE})`);
  } else {
    console.log(`state file has ${holds.length} tracked hold(s):`);
    for (const h of holds) {
      const res = await deleteProbeHold(h.centerId, h.reservationId);
      console.log(
        `  DELETE center=${h.centerId} ${h.reservationId} (bookedAt ${h.bookedAt}) -> ${res.status}${res.ok || res.status === 404 ? " OK" : `  BODY: ${res.text.slice(0, 200)}`}`,
      );
    }
  }

  // 2. Title scan via the P3 list endpoints, in case a crash predated tracking
  //    (should be impossible — tracking is immediate — but belt-and-braces).
  console.log(`\nscanning for stray "${PROBE_TITLE}" reservations via list endpoints (404/405 responses are fine — P3 may show none exists):`);
  const c = args.center;
  const startIso = `${todayYmd()}T00:00:00${tzOffsetFor(todayYmd())}`;
  const endIso = `${addDaysYmd(todayYmd(), 14)}T23:59:00${tzOffsetFor(addDaysYmd(todayYmd(), 14))}`;
  const attempts: Array<{ label: string; method: "GET" | "POST"; path: string; body?: unknown }> = [
    { label: "GET /reservations", method: "GET", path: `/centers/${c}/reservations` },
    { label: "GET /reservations?from&to", method: "GET", path: `/centers/${c}/reservations?from=${enc(startIso)}&to=${enc(endIso)}` },
    {
      label: "POST /reservations/search",
      method: "POST",
      path: `/centers/${c}/reservations/search`,
      body: { Filter: { BookedAtRange: { StartAt: startIso, EndAt: endIso } } },
    },
  ];
  let scanned = false;
  for (const at of attempts) {
    const res = await qamfRaw({ centerId: c, method: at.method, path: at.path, body: at.body, label: `cleanup ${at.label}` });
    console.log(`  ${padr(at.label, 30)} -> ${res.status} (${res.ms} ms)`);
    if (!res.ok) continue;
    const list = extractReservations(res.json);
    const strays = list.filter((r) => typeof r.Title === "string" && (r.Title as string).startsWith("ZZZ API PROBE"));
    console.log(`    parsed ${list.length} reservation(s), ${strays.length} probe stray(s)`);
    for (const s of strays) {
      const id = s.Id === undefined || s.Id === null ? "" : String(s.Id);
      if (!id) continue;
      const del = await deleteProbeHold(c, id);
      console.log(`    DELETE stray ${id} ("${String(s.Title)}") -> ${del.status}`);
    }
    scanned = true;
    break; // first working list shape is enough
  }
  if (!scanned) console.log("  no list endpoint worked — relying on the state file + QAMF's ~10-min Temporary TTL.");

  const remaining = loadHoldState();
  if (remaining.length > 0) {
    console.log(`\nWARNING: ${remaining.length} hold(s) could not be deleted and remain in ${STATE_FILE}:`);
    for (const h of remaining) console.log(`  center=${h.centerId} ${h.reservationId} bookedAt=${h.bookedAt} createdAt=${h.createdAt}`);
    console.log("Re-run cleanup, or verify in Conqueror. Temporary holds self-expire ~10 min after creation.");
  } else {
    console.log("\nstate file clear — no tracked probe holds remain.");
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  fixturesEnabled = args.fixtures;
  fixtureFileName = `${args.sub}-${args.center}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;

  const meta = CENTER_META[args.center];
  console.log(`qamf-duration-probe ${args.sub}`);
  console.log(
    `center: ${meta.label} (${args.center}) | date: ${args.date} (${DOW_NAMES[dowOf(args.date)]}) | time: ${minLabel(args.timeMinutes)} | players: ${args.players} | api-version: ${API_VER} | fixtures: ${args.fixtures ? "on" : "off"}`,
  );

  switch (args.sub) {
    case "baseline":
      await cmdBaseline(args);
      break;
    case "near-close":
      await cmdNearClose(args);
      break;
    case "list-res":
      await cmdListRes(args);
      break;
    case "window":
      await cmdWindow(args);
      break;
    case "filter":
      await cmdFilter(args);
      break;
    case "blocked":
      await cmdBlocked(args);
      break;
    case "hold-codes":
      await cmdHoldCodes(args);
      break;
    case "latency":
      await cmdLatency(args);
      break;
    case "cleanup":
      await cmdCleanup(args);
      break;
  }
}

main()
  .catch((err) => {
    console.error(`\nPROBE FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    console.error(`If a write subcommand crashed mid-run, run: npx tsx scripts/qamf-duration-probe.mts cleanup`);
    process.exitCode = 1;
  })
  .finally(() => {
    flushFixtures();
  });
