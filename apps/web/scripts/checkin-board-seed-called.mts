/**
 * WRITE: force the Redis last-race-per-track keys to Pandora's LIVE answer.
 *
 *   npx tsx scripts/checkin-board-seed-called.mts
 *
 * WHY THIS EXISTS. /api/pandora/races-current fetches Pandora with a 5s
 * timeout and falls back to `pandora:last-race:fasttrax:{track}` on failure.
 * When Pandora is slow FROM VERCEL (2026-08-13: every single call returned
 * X-Cache: TIMEOUT) the fallback is the only thing anyone ever sees — and the
 * every-minute checkin-alerts cron, which is what normally REFRESHES those
 * keys, is timing out through the exact same code path. The carry copy freezes
 * on whichever heat was called before the upstream went slow, and every board
 * in the building shows it.
 *
 * This reads races/current directly (no 5s ceiling — from here Pandora answers
 * fine) and writes what it says into the keys the boards fall back to. It never
 * invents a heat: if Pandora has no entry for a track, that track is LEFT
 * ALONE, so this can only ever replace a stale call with the real current one.
 *
 * `calledAt` is copied through verbatim so the countdowns/"just called"
 * takeover keep the timestamp staff actually pressed the button at, exactly as
 * preserveFirstCall would.
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
const KEY = (t: string) => `pandora:last-race:fasttrax:${t}`;

/** Same TTL the route uses: to midnight ET + the 6h display window + 1h. */
function ttlSeconds(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0", 10);
  const secSoFar = g("hour") * 3600 + g("minute") * 60 + g("second");
  return Math.max(60, 86400 - secSoFar + 6 * 3600 + 3600);
}

const res = await fetch(`${BASE}/bmi/races/current/${LOC}`, {
  headers: { Authorization: `Bearer ${PKEY}`, Accept: "application/json" },
  cache: "no-store",
});
if (!res.ok) {
  console.error(`Pandora races/current HTTP ${res.status} — ABORTING, nothing written.`);
  process.exit(1);
}
const live: any = (await res.json())?.data ?? {};

const { default: Redis } = await import("ioredis");
const redis = new Redis(process.env.REDIS_URL!);
const ttl = ttlSeconds();

for (const track of ["blue", "red", "mega"] as const) {
  const race = live[track];
  if (!race) {
    console.log(`${track.padEnd(5)} Pandora has no called heat — LEFT ALONE`);
    continue;
  }
  const before = await redis.get(KEY(track));
  const prev = before ? JSON.parse(before) : null;
  await redis.set(KEY(track), JSON.stringify(race), "EX", ttl);
  console.log(
    `${track.padEnd(5)} heat ${prev?.heatNumber ?? "-"} (sid ${prev?.sessionId ?? "-"})` +
      `  ->  heat ${race.heatNumber} (sid ${race.sessionId})  ${race.raceType}` +
      `  calledAt=${race.calledAt}  ttl=${ttl}s`,
  );
}

console.log("\nVerify:");
for (const track of ["blue", "red", "mega"] as const) {
  const raw = await redis.get(KEY(track));
  console.log(`  ${track.padEnd(5)} ${raw ?? "EMPTY"}`);
}
await redis.quit();
