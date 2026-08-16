/**
 * Junior-heat neighbor audit — "what would a BMI product limit have to do?"
 *
 * Question being answered (owner 2026-08-16): every time a junior race is
 * booked, what is running in the heats NEXT TO IT, and what would it cost us to
 * lock a BMI product limit on those neighbors?
 *
 * We already forbid a new junior session adjacent to another junior session
 * (`blue/mega-no-back-to-back-junior` in race-restriction-rules.ts, gap 13 min)
 * — but ONLY on our web + kiosk surfaces. The register, the phone and BMI's own
 * dayplanner never see that rule. BMI's own enforcement primitive is a PRODUCT
 * LIMIT locked on a heat (`GET /v2/bmi/product-limits/{loc}` →
 * `PATCH /v2/bmi/session/{loc}` with `productLimitId`), which our booking v2
 * deliberately does not send today (owner decision 2026-07-01).
 *
 * This script measures the gap before we build anything:
 *   1. every junior race session that actually got booked, per track per day;
 *   2. every session within ±GAP_MINUTES of it (its "neighbors");
 *   3. how many of those neighbors the candidate limit "Adult Starter &
 *      Intermediate" (id 53253885) would have FORBIDDEN — i.e. real bookings we
 *      would have turned away had the limit been locked;
 *   4. junior↔junior adjacencies that happened anyway — the leak our web-only
 *      rule cannot see (register / walk-in / phone).
 *
 * Read-only. Hits Pandora `GET /v2/bmi/sessions` only; writes nothing.
 *
 *   npx tsx scripts/junior-heat-neighbor-audit.mts [--days 30] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--gap 13] [--json]
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
/** Races run only at FastTrax Fort Myers. */
const LOCATION_ID = "LAB52GY480CJF";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
if (!KEY) {
  console.error("SWAGGER_ADMIN_KEY missing from .env.local");
  process.exit(1);
}

/**
 * The BMI product limit we would lock on a junior heat's neighbors.
 *
 * Was "Adult Starter & Intermediate"; ops renamed it "Adult" on 2026-08-16 and
 * added the adult Pro products, so its meaning is now exactly "no juniors" —
 * which is the whole point of the rule. Membership is NOT readable from the API
 * (`GET /bmi/product-limits` returns {id,name} only), so this scoping is taken
 * on ops' word, not verified here.
 */
const CANDIDATE_LIMIT = { id: 53253885, name: "Adult" };

/**
 * Would the limit refuse this neighbor booking?
 *  - junior of any tier  → REFUSED (intended)
 *  - adult GF (group function) → UNKNOWN: GF races are their own SKUs and
 *    nobody has confirmed they're in the limit. A GF party refused next to a
 *    junior heat is a booked event failing at the register, so this bucket has
 *    to be resolved before the limit goes on anything.
 *  - every other adult tier (starter / intermediate / pro) → allowed
 */
type Verdict = "allowed" | "refused" | "unknown";
const verdictFor = (h: Heat): Verdict => (h.junior ? "refused" : h.gf ? "unknown" : "allowed");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const JSON_OUT = argv.includes("--json");
/** Same 13 min the back-to-back rule uses (12-min cadence + 1). */
const GAP_MINUTES = Number(arg("gap") ?? 13);
const DAYS = Number(arg("days") ?? 30);

const todayEt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const END = arg("end") ?? todayEt;
const START = arg("start") ?? shiftDate(END, -(DAYS - 1));

function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

// ── Pandora ─────────────────────────────────────────────────────────────────
interface PandoraSession {
  sessionId: string;
  name: string;
  /** UTC instant, e.g. "2026-08-15T15:24:00.000Z". */
  scheduledStart: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  type: string | null;
  heatNumber: number | null;
}

async function sessionsForDate(date: string): Promise<PandoraSession[]> {
  // The range is center-local per the API contract; a full local day is safe to
  // ask for as 00:00:00..23:59:59.
  const url =
    `${PANDORA_BASE}/bmi/sessions/${LOCATION_ID}` +
    `?startDate=${date}T00:00:00&endDate=${date}T23:59:59`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${date}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { success: boolean; data?: PandoraSession[] };
  return body.data ?? [];
}

// ── heat parsing ────────────────────────────────────────────────────────────
type Tier = "starter" | "intermediate" | "pro";

interface Heat {
  sessionId: string;
  name: string;
  track: "Red" | "Blue" | "Mega";
  junior: boolean;
  tier: Tier;
  /** Group-function heat ("Blue GF Starter") — a booked private session. */
  gf: boolean;
  /** Center-local date + clock, derived from the UTC instant. */
  dateEt: string;
  clockEt: string;
  startMs: number;
  ran: boolean;
}

const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function etParts(iso: string): { date: string; clock: string } {
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, clock: `${p.hour}:${p.minute}` };
}

/**
 * "13 - Blue Junior Intermediate" / "68 - Blue Starter" / "7 - Blue GF Starter"
 * / "66 - Blue Starter Restarted". Anything else (Laser Tag, Gel Blaster, Mini
 * Track, Birthday) is not a race and returns null.
 */
const HEAT_RE = /^\s*\d+\s*-\s*(Red|Blue|Mega)\s+(GF\s+)?(Junior\s+)?(Starter|Intermediate|Pro)\b/i;

function parseHeat(s: PandoraSession): Heat | null {
  if (!s.scheduledStart) return null;
  const m = s.name.match(HEAT_RE);
  if (!m) return null;
  const { date, clock } = etParts(s.scheduledStart);
  const track = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as Heat["track"];
  return {
    sessionId: s.sessionId,
    name: s.name,
    track,
    gf: Boolean(m[2]),
    junior: Boolean(m[3]),
    tier: m[4].toLowerCase() as Tier,
    dateEt: date,
    clockEt: clock,
    startMs: new Date(s.scheduledStart).getTime(),
    ran: Boolean(s.actualStart),
  };
}

/** A "Restarted" row is the same physical heat run twice — one block, one entry. */
function dedupeBlocks(heats: Heat[]): Heat[] {
  const byBlock = new Map<string, Heat>();
  for (const h of heats) {
    const key = `${h.track}|${h.startMs}`;
    const prev = byBlock.get(key);
    if (!prev) byBlock.set(key, h);
    else if (!prev.ran && h.ran) byBlock.set(key, h); // keep the one that ran
  }
  return [...byBlock.values()].sort((a, b) => a.startMs - b.startMs);
}

const label = (h: Heat) =>
  `${h.track} ${h.gf ? "GF " : ""}${h.junior ? "Junior " : ""}${h.tier[0].toUpperCase()}${h.tier.slice(1)}`;

// ── main ────────────────────────────────────────────────────────────────────
const dates = eachDate(START, END);
if (!JSON_OUT) {
  console.log(
    `Junior-heat neighbor audit — ${START} → ${END} (${dates.length} days), gap ±${GAP_MINUTES} min`,
  );
  console.log(`Candidate limit: "${CANDIDATE_LIMIT.name}" (id ${CANDIDATE_LIMIT.id})\n`);
}

const all: Heat[] = [];
const failures: string[] = [];
// Serial with a small batch — Pandora is a Firebird passthrough, not a CDN.
for (let i = 0; i < dates.length; i += 4) {
  const batch = dates.slice(i, i + 4);
  const results = await Promise.all(
    batch.map(async (d) => {
      try {
        return (await sessionsForDate(d)).map(parseHeat).filter((h): h is Heat => h != null);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
        return [];
      }
    }),
  );
  for (const r of results) all.push(...r);
}

const heats = dedupeBlocks(all);
const gapMs = GAP_MINUTES * 60_000;

interface Row {
  junior: Heat;
  neighbors: { heat: Heat; deltaMin: number; verdict: Verdict }[];
}

const rows: Row[] = [];
for (const j of heats) {
  if (!j.junior) continue;
  const neighbors = heats
    .filter(
      (n) =>
        n.track === j.track &&
        n.startMs !== j.startMs &&
        Math.abs(n.startMs - j.startMs) < gapMs,
    )
    .map((n) => ({
      heat: n,
      deltaMin: Math.round((n.startMs - j.startMs) / 60_000),
      verdict: verdictFor(n),
    }))
    .sort((a, b) => a.deltaMin - b.deltaMin);
  rows.push({ junior: j, neighbors });
}

// ── aggregates ──────────────────────────────────────────────────────────────
const juniorHeats = rows.length;
const withNeighbors = rows.filter((r) => r.neighbors.length > 0);
/** Distinct neighbor blocks — the slots a limit would have to be locked onto. */
const neighborBlocks = new Map<string, { heat: Heat; verdict: Verdict }>();
for (const r of withNeighbors)
  for (const n of r.neighbors)
    neighborBlocks.set(`${n.heat.track}|${n.heat.startMs}`, {
      heat: n.heat,
      verdict: n.verdict,
    });
const refusedBlocks = [...neighborBlocks.values()].filter((n) => n.verdict === "refused");
const unknownBlocks = [...neighborBlocks.values()].filter((n) => n.verdict === "unknown");
const juniorAdjacent = withNeighbors.filter((r) => r.neighbors.some((n) => n.heat.junior));

const byNeighborKind = new Map<string, number>();
for (const n of neighborBlocks.values())
  byNeighborKind.set(label(n.heat), (byNeighborKind.get(label(n.heat)) ?? 0) + 1);

const byTrack = new Map<string, { junior: number; adjacent: number }>();
for (const r of rows) {
  const t = byTrack.get(r.junior.track) ?? { junior: 0, adjacent: 0 };
  t.junior++;
  if (r.neighbors.length) t.adjacent++;
  byTrack.set(r.junior.track, t);
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        window: { start: START, end: END, days: dates.length, gapMinutes: GAP_MINUTES },
        candidateLimit: CANDIDATE_LIMIT,
        totals: {
          raceHeats: heats.length,
          juniorHeats,
          juniorWithNeighbors: withNeighbors.length,
          juniorAdjacentToJunior: juniorAdjacent.length,
          distinctNeighborBlocks: neighborBlocks.size,
          neighborBlocksTheLimitWouldRefuse: refusedBlocks.length,
          neighborBlocksOfUnknownStatus: unknownBlocks.length,
        },
        byTrack: Object.fromEntries(byTrack),
        neighborKinds: Object.fromEntries(byNeighborKind),
        rows: rows.map((r) => ({
          date: r.junior.dateEt,
          clock: r.junior.clockEt,
          heat: label(r.junior),
          sessionId: r.junior.sessionId,
          neighbors: r.neighbors.map((n) => ({
            clock: n.heat.clockEt,
            deltaMin: n.deltaMin,
            heat: label(n.heat),
            sessionId: n.heat.sessionId,
            verdict: n.verdict,
          })),
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// ── report ──────────────────────────────────────────────────────────────────
let currentDate = "";
for (const r of rows) {
  if (r.junior.dateEt !== currentDate) {
    currentDate = r.junior.dateEt;
    console.log(`\n── ${currentDate} ──`);
  }
  const flag = r.neighbors.some((n) => n.heat.junior) ? "  ⚠ JUNIOR ADJACENT" : "";
  console.log(`  ${r.junior.clockEt}  ${label(r.junior)}${flag}`);
  if (!r.neighbors.length) {
    console.log(`           (no heat within ±${GAP_MINUTES} min — limit would cost nothing)`);
    continue;
  }
  for (const n of r.neighbors) {
    const sign = n.deltaMin > 0 ? `+${n.deltaMin}` : `${n.deltaMin}`;
    const note =
      n.verdict === "refused"
        ? `   ← "${CANDIDATE_LIMIT.name}" would have REFUSED this booking`
        : n.verdict === "unknown"
          ? `   ← GF SKU — in the limit or not? unconfirmed`
          : "";
    console.log(`           ${sign.padStart(3)}m  ${n.heat.clockEt}  ${label(n.heat)}${note}`);
  }
}

console.log(`\n${"═".repeat(72)}`);
console.log(`Race heats booked in window ........................ ${heats.length}`);
console.log(`Junior heats booked ................................ ${juniorHeats}`);
console.log(
  `  …with a heat within ±${GAP_MINUTES} min ..................... ${withNeighbors.length}` +
    (juniorHeats ? `  (${Math.round((withNeighbors.length / juniorHeats) * 100)}%)` : ""),
);
console.log(`  …adjacent to ANOTHER JUNIOR heat (rule leak) ..... ${juniorAdjacent.length}`);
console.log(`Distinct neighbor blocks needing a limit ........... ${neighborBlocks.size}`);
console.log(
  `Neighbor bookings "${CANDIDATE_LIMIT.name}" would refuse (INTENDED) . ${refusedBlocks.length}`,
);
console.log(
  `  …of which are GF SKUs of unconfirmed status ...... ${unknownBlocks.length}  ← resolve before shipping`,
);
console.log(`\nWhat was actually running next to a junior heat:`);
for (const [kind, n] of [...byNeighborKind.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(n).padStart(4)}  ${kind}`);
console.log(`\nPer track:`);
for (const [track, t] of byTrack)
  console.log(`  ${track.padEnd(5)} junior heats ${t.junior}, of which ${t.adjacent} had neighbors`);
if (failures.length) {
  console.log(`\n⚠ ${failures.length} day(s) failed to fetch:`);
  for (const f of failures.slice(0, 10)) console.log(`   ${f}`);
}
process.exit(0);
