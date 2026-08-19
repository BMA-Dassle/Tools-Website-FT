/**
 * THE SHADOW DAY SCOREBOARD — did the venue WebSocket know every called heat, and
 * how much sooner than the Pandora poll?
 *
 * LEFT  = `venue:called:log`, written by venue-called.server.ts on the webhook's
 *         hot path: the venue's own call stamp plus the moment the frame reached
 *         US (bridge hop and POST included, so it is the honest comparison).
 * RIGHT = `briefing_events.called_at` — what our system actually recorded from the
 *         Pandora carry, i.e. the number a board displayed.
 *
 * The four questions this has to answer before any writer is promoted:
 *   1. COVERAGE — every heat Pandora saw called, did the WS see it too?
 *   2. TRACK    — was a heat ever attributed to the wrong track, or to none?
 *   3. LEAD     — how much sooner, and was it ever LATER?
 *   4. RE-CALLS — did a re-called heat keep its first stamp?
 *
 * Read-only. Safe to run mid-day; run it again after close for the full picture.
 *
 *   npx tsx scripts/venue-called-diff.mts [businessDay=today]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const day =
  process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const et = (ms: number | null | undefined) =>
  ms == null
    ? "—".padEnd(12)
    : new Date(ms)
        .toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })
        .padEnd(12);

const { default: redis } = await import("../lib/redis");
const sql = neon(process.env.DATABASE_URL!);

interface LogEntry {
  event: "call" | "start" | "finish";
  sessionId: string;
  track: string;
  heatNumber: number | null;
  sessionName: string;
  calledAtMs: number | null;
  seenAtMs: number;
}

const rawLog = await redis.lrange("venue:called:log", 0, -1);
const log: LogEntry[] = rawLog
  .map((r) => {
    try {
      return JSON.parse(r) as LogEntry;
    } catch {
      return null;
    }
  })
  .filter((e): e is LogEntry => e !== null);

/** First call per session, and how many call events it got (re-calls). */
const wsCalls = new Map<
  string,
  {
    track: string;
    heat: number | null;
    name: string;
    calledAtMs: number | null;
    seenAtMs: number;
    calls: number;
  }
>();
for (const e of log.filter((e) => e.event === "call").reverse()) {
  const prev = wsCalls.get(e.sessionId);
  if (prev) {
    prev.calls++;
    continue;
  }
  wsCalls.set(e.sessionId, {
    track: e.track,
    heat: e.heatNumber,
    name: e.sessionName,
    calledAtMs: e.calledAtMs,
    seenAtMs: e.seenAtMs,
    calls: 1,
  });
}

const rows = (await sql`
  SELECT session_id, heat_number, race_type, track, MIN(called_at) AS called_at
  FROM briefing_events
  WHERE called_at IS NOT NULL AND business_day = ${day}
  GROUP BY session_id, heat_number, race_type, track
  ORDER BY MIN(called_at)
`) as Array<{
  session_id: string;
  heat_number: number;
  race_type: string;
  track: string;
  called_at: string;
}>;

console.log(
  `business day ${day} — Pandora recorded ${rows.length} called heats · WS logged ${wsCalls.size}\n`,
);
console.log(
  `${"heat".padEnd(26)} ${"WS seen".padEnd(12)} ${"we recorded".padEnd(12)} ${"lead".padEnd(9)} track  re-calls`,
);

const leads: number[] = [];
let missing = 0;
let wrongTrack = 0;

for (const r of rows) {
  const ws = wsCalls.get(String(r.session_id));
  const pandoraMs = Date.parse(r.called_at);
  const label = `${r.heat_number} - ${r.track} ${r.race_type}`.slice(0, 25);
  if (!ws) {
    missing++;
    console.log(`${label.padEnd(26)} ${"NOT SEEN".padEnd(12)} ${et(pandoraMs)} ${"—".padEnd(9)} —`);
    continue;
  }
  const leadSec = (pandoraMs - ws.seenAtMs) / 1000;
  leads.push(leadSec);
  const trackOk = ws.track.toLowerCase() === String(r.track).toLowerCase();
  if (!trackOk) wrongTrack++;
  console.log(
    `${label.padEnd(26)} ${et(ws.seenAtMs)} ${et(pandoraMs)} ` +
      `${`${leadSec >= 0 ? "+" : ""}${leadSec.toFixed(1)}s`.padEnd(9)} ` +
      `${trackOk ? ws.track : `WRONG(${ws.track}≠${r.track})`}  ${ws.calls > 1 ? `${ws.calls}×` : ""}`,
  );
}

/** Heats the WS saw that Pandora never recorded — the other direction. */
const extra = [...wsCalls.entries()].filter(
  ([sid]) => !rows.some((r) => String(r.session_id) === sid),
);

console.log(`\n── verdict ──`);
console.log(
  `  coverage    ${rows.length - missing}/${rows.length} called heats seen by the WS` +
    (missing ? `  ⚠ ${missing} MISSED` : "  ✓"),
);
console.log(
  `  track       ${wrongTrack === 0 ? "✓ no wrong-track attributions" : `⚠ ${wrongTrack} WRONG`}`,
);
if (leads.length) {
  const s = [...leads].sort((a, b) => a - b);
  const later = s.filter((v) => v < 0).length;
  console.log(
    `  lead        median ${s[Math.floor(s.length / 2)].toFixed(1)}s · min ${s[0].toFixed(1)}s · max ${s[s.length - 1].toFixed(1)}s` +
      (later ? `  (${later} arrived LATER than the poll)` : ""),
  );
}
const recalled = [...wsCalls.values()].filter((v) => v.calls > 1).length;
console.log(`  re-calls    ${recalled} heat(s) called more than once — first stamp kept in all`);
if (extra.length) {
  console.log(
    `  WS-only     ${extra.length} heat(s) the WS saw called but Pandora never recorded:`,
  );
  for (const [sid, v] of extra.slice(0, 10)) {
    console.log(
      `                ${v.track} heat ${v.heat ?? "?"} session ${sid} at ${et(v.seenAtMs).trim()}`,
    );
  }
}

redis.disconnect?.();
process.exit(0);
