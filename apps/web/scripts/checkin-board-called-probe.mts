/**
 * READ-ONLY: why isn't a called heat on the check-in board?
 *
 *   npx tsx scripts/checkin-board-called-probe.mts
 *
 * The board's session strip is /api/admin/checkin?action=session-stats, which
 * reads /api/pandora/races-current, which is Pandora's races/current MERGED
 * with the Redis last-race-per-track keys. So there are exactly three places a
 * called heat can go missing. This prints all three:
 *
 *   1. Pandora  GET /v2/bmi/races/current/{loc}   — the live called signal
 *   2. Redis    pandora:last-race:fasttrax:{track} — the between-heats carry
 *   3. Today's schedule, so we can name the sessionId of a heat by number.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const H = { Authorization: `Bearer ${PKEY}`, Accept: "application/json" };

const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

console.log(`ET date ${ymd} — now ${new Date().toISOString()}`);

// ── 1. Pandora live called signal ───────────────────────────────────────────
console.log("\n=== 1. Pandora races/current ===");
try {
  const res = await fetch(`${BASE}/bmi/races/current/${LOC}`, { headers: H, cache: "no-store" });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 2000));
} catch (e) {
  console.log("FETCH FAILED:", e instanceof Error ? e.message : e);
}

// ── 2. Redis last-race carry ────────────────────────────────────────────────
console.log("\n=== 2. Redis pandora:last-race:fasttrax:* ===");
{
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL!);
  for (const t of ["blue", "red", "mega"]) {
    const key = `pandora:last-race:fasttrax:${t}`;
    const raw = await redis.get(key);
    const ttl = await redis.ttl(key);
    if (!raw) {
      console.log(`${t.padEnd(5)} EMPTY`);
      continue;
    }
    const r = JSON.parse(raw);
    const ageMin = r.calledAt ? (Date.now() - new Date(r.calledAt).getTime()) / 60000 : NaN;
    console.log(
      `${t.padEnd(5)} sid=${r.sessionId} heat=${r.heatNumber} ${r.raceType} ` +
        `calledAt=${r.calledAt} age=${ageMin.toFixed(1)}min ttl=${ttl}s`,
    );
  }
  await redis.quit();
}

// ── 3. Today's schedule per track ───────────────────────────────────────────
console.log("\n=== 3. Today's sessions per track ===");
for (const track of ["Blue Track", "Red Track", "Mega Track"]) {
  const qs = new URLSearchParams({
    locationId: LOC,
    resourceName: track,
    startDate: `${ymd}T00:00:00`,
    endDate: `${ymd}T23:59:59`,
  }).toString();
  try {
    const res = await fetch(`${BASE}/bmi/sessions?${qs}`, { headers: H, cache: "no-store" });
    if (!res.ok) {
      console.log(`${track}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const json: any = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    console.log(`\n${track} — ${list.length} sessions`);
    for (const s of list) {
      console.log(
        `  heat ${String(s.heatNumber ?? "?").padStart(3)} sid=${s.sessionId} ` +
          `${s.scheduledStart ?? ""} ${s.raceType ?? s.type ?? s.name ?? ""}`,
      );
    }
  } catch (e) {
    console.log(`${track}: FAILED`, e instanceof Error ? e.message : e);
  }
}
