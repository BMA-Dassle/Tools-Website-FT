/**
 * READ-ONLY: how hard does the check-in board hit Pandora?
 *
 *   npx tsx scripts/checkin-board-pandora-load.mts
 *
 * The board (/admin/{token}/checkin) polls
 * /api/admin/checkin?action=session-stats every 5s. That handler fans out to
 * Pandora with NO cache in front of it:
 *
 *   1 x  races/current            (via the internal /api/pandora/races-current
 *                                  hop, which has a 12s per-lambda memory cache)
 *   1 x  sessions/current/{HPFM}  (DIRECT, uncached)
 *   N x  session/{loc}/{sid}/participants   (DIRECT, uncached — one per
 *                                            currently-called session)
 *
 * So the per-tab rate is (2 + N) x 12 calls/minute. This measures N right now
 * and times each leg, so the number is the real one and not an estimate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const FT = "LAB52GY480CJF";
const HPFM = "TXBSQN0FEKQ11";
const BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const H = { Authorization: `Bearer ${PKEY}`, Accept: "application/json" };

async function timed(label: string, url: string) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: H, cache: "no-store" });
    const json: any = await res.json().catch(() => null);
    const ms = Date.now() - t0;
    return { label, ok: res.ok, status: res.status, ms, json };
  } catch (e) {
    return {
      label,
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      json: null,
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

console.log(`now ${new Date().toISOString()}\n`);

// ── leg 1: races/current (the racing half of the session strip) ─────────────
const races = await timed("races/current", `${BASE}/bmi/races/current/${FT}`);
console.log(`races/current            HTTP ${races.status} ${races.ms}ms`);
const racingSids: string[] = [];
for (const t of ["blue", "red", "mega"]) {
  const r = races.json?.data?.[t];
  if (r?.sessionId) {
    racingSids.push(String(r.sessionId));
    console.log(`  ${t.padEnd(5)} sid=${r.sessionId} heat=${r.heatNumber} calledAt=${r.calledAt}`);
  } else {
    console.log(`  ${t.padEnd(5)} null (board falls back to the Redis carry)`);
  }
}

// ── leg 2: arena sessions/current (uncached, every single poll) ─────────────
const arena = await timed("sessions/current", `${BASE}/bmi/sessions/current/${HPFM}`);
console.log(`\nsessions/current (HPFM)  HTTP ${arena.status} ${arena.ms}ms`);
const arenaSids: string[] = [];
for (const s of Array.isArray(arena.json?.data) ? arena.json.data : []) {
  arenaSids.push(String(s.sessionId ?? ""));
  console.log(`  sid=${s.sessionId} type=${s.type ?? "?"} start=${s.scheduledStart ?? "?"}`);
}
if (!arenaSids.length) console.log("  (none called)");

// ── leg 3: one participants call per called session ─────────────────────────
console.log(`\nparticipants fan-out — one call per called session, every poll`);
const legs = [
  ...racingSids.map((sid) => ({ sid, loc: FT })),
  ...arenaSids.filter(Boolean).map((sid) => ({ sid, loc: HPFM })),
];
let slowest = 0;
for (const { sid, loc } of legs) {
  const p = await timed(
    "participants",
    `${BASE}/bmi/session/${loc}/${sid}/participants?excludeRemoved=true`,
  );
  const n = Array.isArray(p.json?.data) ? p.json.data.length : -1;
  slowest = Math.max(slowest, p.ms);
  console.log(`  sid=${sid.padEnd(10)} HTTP ${p.status} ${String(p.ms).padStart(5)}ms  ${n} rows`);
}
if (!legs.length) console.log("  (no called sessions right now — fan-out is 0)");

// ── the arithmetic ──────────────────────────────────────────────────────────
const N = legs.length;
const perPoll = 2 + N; // races-current hop + arena sessions/current + N participants
const perMin = perPoll * 12; // 5s poll = 12 polls/min
console.log(`\n── per OPEN BOARD TAB ─────────────────────────────`);
console.log(`  called sessions N          = ${N}`);
console.log(`  Pandora calls per poll     = ${perPoll}  (2 fixed + ${N} participants)`);
console.log(`  Pandora calls per minute   = ${perMin}`);
console.log(`  Pandora calls per hour     = ${perMin * 60}`);
console.log(`  slowest participants leg   = ${slowest}ms`);
console.log(`\n  x2 tabs = ${perMin * 2}/min   x4 tabs = ${perMin * 4}/min`);
console.log(
  `\nNote: races-current has a 12s per-lambda memory cache, so its own upstream\n` +
    `rate is at most 5/min PER LAMBDA INSTANCE — but Vercel fans concurrent\n` +
    `polls across instances, so treat it as closer to 12/min under load.`,
);
