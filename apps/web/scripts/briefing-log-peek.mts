/**
 * READ-ONLY: what does the briefing log hold?
 *
 * The command-line twin of the check-in board's "Briefing log — today" strip, and
 * the thing to run when an insurance or incident question arrives about a specific
 * group ("did heat 24 on 8/12 get the safety briefing, and for how long were they in
 * the room?"). Reads `briefing_events` — append-only, see
 * src/features/signage/briefing/events-db.ts.
 *
 *   npx tsx scripts/briefing-log-peek.mts              # today's log, folded
 *   npx tsx scripts/briefing-log-peek.mts 58509552     # one session, raw events
 *   DAY=2026-08-11 npx tsx scripts/briefing-log-peek.mts
 *
 * Run from apps/web (it reads .env.local from the working directory).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const SESSION = process.argv[2] || null;

const et = (v: unknown) =>
  new Date(String(v)).toLocaleString("en-US", { timeZone: "America/New_York" });
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// Does the table exist at all? A missing table and an empty day are very different
// answers, and only one of them is a problem.
const cols = (await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'briefing_events'`) as any[];
if (cols.length === 0) {
  console.log("briefing_events: TABLE MISSING — no briefing has been sent since the log shipped");
  process.exit(0);
}
console.log(`briefing_events: ${cols.length} columns`);

if (SESSION) {
  const rows = (await sql`
    SELECT * FROM briefing_events WHERE session_id = ${SESSION} ORDER BY at ASC`) as any[];
  console.log(`\nsession ${SESSION} — ${rows.length} events`);
  for (const r of rows) {
    console.log(
      ` ${et(r.at)}  ${String(r.room).toUpperCase().padEnd(5)} ${String(r.action).padEnd(10)}` +
        `${r.reason ? "/" + r.reason : ""} heat ${r.heat_number ?? "?"} ${r.race_type ?? ""} ` +
        `${r.tier ?? ""}${r.video_ms ? ` film ${clock(Number(r.video_ms))}` : ""}`,
    );
  }
  process.exit(0);
}

const day = process.env.DAY || new Date().toISOString().slice(0, 10);
const rows = (await sql`
  SELECT * FROM briefing_events WHERE business_day = ${day} ORDER BY at ASC`) as any[];
console.log(`\nbusiness day ${day} — ${rows.length} events`);

// Fold to one line per (room, session): the insurance answer.
const groups = new Map<string, any[]>();
for (const r of rows) {
  const k = `${r.room}::${r.session_id}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const HELMET_MS = 30_000;
for (const [k, evs] of groups) {
  const sent = evs.find((e) => e.action === "sent");
  const starts = evs.filter((e) => e.action === "started" || e.action === "restarted");
  const ended = evs.find((e) => e.action === "ended");
  const film = starts.find((e) => e.video_ms != null) ?? starts[0];
  const sentMs = Date.parse(String((sent ?? evs[0]).at));
  const lastStart = starts.length ? Date.parse(String(starts[starts.length - 1].at)) : null;
  const filmMs = film?.video_ms != null ? Number(film.video_ms) : null;
  const derived = lastStart != null && filmMs ? lastStart + filmMs + HELMET_MS : null;
  const endMs = ended ? Date.parse(String(ended.at)) : derived != null ? derived : null;
  const kind = ended ? (ended.reason ?? "cleared") : derived != null ? "film-complete" : "open";
  console.log(
    `\n ${k}  heat ${(sent ?? evs[0]).heat_number ?? "?"} ${(sent ?? evs[0]).race_type ?? ""}` +
      `\n   in at      ${et((sent ?? evs[0]).at)}` +
      `\n   film       ${starts.length === 0 ? "NEVER STARTED" : `${film?.tier ?? "?"} ${filmMs ? clock(filmMs) : "length unknown"} started ${et(starts[0].at)}${starts.length > 1 ? ` (+${starts.length - 1} replay)` : ""}`}` +
      `\n   left       ${endMs != null ? `${et(new Date(endMs))} (${kind})` : "still in the room"}` +
      `\n   in room    ${endMs != null ? clock(endMs - sentMs) : "—"}`,
  );
}
