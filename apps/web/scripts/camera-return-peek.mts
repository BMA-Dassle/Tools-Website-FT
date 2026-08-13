/**
 * READ-ONLY: what does the briefing-room camera strip say right now, and why?
 *
 * The command-line twin of the strip along the bottom of the briefing TVs. Run it
 * when a camera is red and nobody believes it, or absent and nobody believes that
 * either: it prints the FACTS behind every box, so you can see which one is
 * missing.
 *
 *   the scan     camera-scan-log:{businessDay}     did staff scan it out?
 *   the flag     briefing:race-finished:{id}       did we learn the race ended?
 *   the call     pandora:last-race:fasttrax:{trk}  has the next heat gone up?
 *   the sighting camera-seen:{camera}              has it registered since?
 *   the bench    camera_maintenance                is it known-broken?
 *
 * THE VERDICT COMES FROM THE SHIPPED FUNCTION — `cameraReturnStripAt` is imported,
 * not reimplemented, so this tool cannot drift from the wall. An earlier cut kept
 * its own copy of the rules and was wrong within a day of the model changing.
 *
 *   npx tsx scripts/camera-return-peek.mts            # today
 *   DAY=2026-08-11 npx tsx scripts/camera-return-peek.mts
 *
 * Run from apps/web (it reads .env.local from the working directory). NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";
import { neon } from "@neondatabase/serverless";
import type {
  CameraScan,
  CameraTrack,
  SessionFinish,
  TrackCall,
} from "../src/features/signage/briefing/camera-return";

// Dynamic: a .mts entry point will not statically link a .ts module through tsx's
// ESM loader, and importing the REAL decision function is the whole point.
const { cameraReturnStripAt, formatSinceFlag } =
  await import("../src/features/signage/briefing/camera-return");

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });
const sql = neon(process.env.DATABASE_URL!);
const TRACKS: CameraTrack[] = ["blue", "red", "mega"];

const et = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: true });

/** Racing business day — 2 AM ET rollover. Mirrors lib/race-business-day.ts;
 *  duplicated rather than imported so this script stays runnable standalone. */
function businessDayYmdET(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  if (parseInt(get("hour") || "0", 10) >= 2) return ymd;
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const day = process.env.DAY || businessDayYmdET();
  const nowMs = Date.now();
  console.log(`\n=== camera return strip · business day ${day} · ${et(nowMs)} ET ===\n`);

  // ── the bench ────────────────────────────────────────────────────────
  const benchRows = (await sql`
    SELECT camera_number, reason FROM camera_maintenance WHERE cleared_at IS NULL
    ORDER BY camera_number
  `.catch(() => [])) as Array<{ camera_number: number; reason: string | null }>;
  const benched = new Set(benchRows.map((b) => String(b.camera_number)));
  if (benchRows.length) {
    console.log(`ON THE MAINTENANCE BENCH — hidden from the strip:`);
    for (const b of benchRows) {
      console.log(`  cam ${String(b.camera_number).padStart(3)}  ${b.reason ?? "—"}`);
    }
    console.log();
  }

  // ── the scans ────────────────────────────────────────────────────────
  const raw = await redis.zrange(`camera-scan-log:${day}`, 0, -1);
  if (raw.length === 0) {
    console.log(`camera-scan-log:${day} is EMPTY.`);
    console.log(`  Either no camera has been scanned out yet on this racing day, or the`);
    console.log(`  index write in lib/camera-assign.ts is not deployed. The strip would`);
    console.log(`  show its all-clear line.\n`);
    await redis.quit();
    return;
  }

  const scans: CameraScan[] = [];
  const racerFor = new Map<string, string>();
  let skippedBenched = 0;
  for (const r of raw) {
    try {
      const e = JSON.parse(r);
      const at = Date.parse(String(e.at ?? ""));
      if (!e.sys || !e.sid || !Number.isFinite(at)) continue;
      const camera = String(e.sys);
      if (benched.has(camera)) {
        skippedBenched += 1;
        continue;
      }
      scans.push({ camera, sessionId: String(e.sid), assignedAtMs: at });
      racerFor.set(`${camera}:${e.sid}`, `${e.fn ?? ""} ${e.ln ?? ""}`.trim());
    } catch {
      /* skip */
    }
  }
  const cameras = [...new Set(scans.map((s) => s.camera))];
  console.log(
    `${scans.length} scans, ${cameras.length} cameras` +
      (skippedBenched ? `  (${skippedBenched} scans hidden — benched cameras)` : ""),
  );

  // ── the flags ────────────────────────────────────────────────────────
  const sessionIds = [...new Set(scans.map((s) => s.sessionId))];
  const finishes = new Map<string, SessionFinish>();
  const markerRaws = await redis.mget(...sessionIds.map((s) => `briefing:race-finished:${s}`));
  markerRaws.forEach((v, i) => {
    if (!v) return;
    try {
      const m = JSON.parse(v);
      if (!Number.isFinite(m.endedAtMs)) return;
      const t = m.track;
      finishes.set(sessionIds[i], {
        endedAtMs: m.endedAtMs,
        heatNumber: m.heatNumber ?? null,
        track: t === "blue" || t === "red" || t === "mega" ? t : null,
        // Markers only in this tool — it does not apply the Pandora backstop the
        // server does, which is why its verdict can disagree with the wall on a
        // night the kart bridge is dropping pushes. See the header.
        source: "flag",
      });
    } catch {
      /* skip */
    }
  });

  // ── the calls ────────────────────────────────────────────────────────
  // The TIME matters as much as the heat number — calls run ahead of finishes, so
  // only a call that post-dates a flag settles that heat's cameras.
  const calledHeats = new Map<CameraTrack, TrackCall>();
  const markVals = await redis.mget(...TRACKS.map((t) => `pandora:last-race:fasttrax:${t}`));
  TRACKS.forEach((t, i) => {
    if (!markVals[i]) return;
    try {
      const w = JSON.parse(markVals[i]!);
      if (typeof w.heatNumber === "number") {
        calledHeats.set(t, { heatNumber: w.heatNumber, calledAtMs: Date.parse(w.calledAt ?? "") });
      }
    } catch {
      /* skip */
    }
  });

  // ── the sightings ────────────────────────────────────────────────────
  const seen = new Map<string, number>();
  const seenRaws = await redis.mget(...cameras.map((c) => `camera-seen:${c}`));
  seenRaws.forEach((v, i) => {
    if (!v) return;
    const ms = Number(v);
    if (Number.isFinite(ms)) seen.set(cameras[i], ms);
  });

  console.log(
    `flags: ${finishes.size}/${sessionIds.length} sessions finished   ` +
      `sightings: ${seen.size}/${cameras.length} cameras   ` +
      `called: ${
        [...calledHeats]
          .map(
            ([t, c]) =>
              `${t} heat ${c.heatNumber} at ${Number.isFinite(c.calledAtMs) ? et(c.calledAtMs) : "?"}`,
          )
          .join(", ") || "nothing"
      }\n`,
  );

  // ── THE SHIPPED VERDICT ──────────────────────────────────────────────
  const strip = cameraReturnStripAt({ scans, finishes, seen, calledHeats, nowMs });

  if (strip.stillOut.length + strip.incoming.length === 0) {
    console.log(`THE STRIP IS CLEAR — it shows "Cameras all in".\n`);
  }
  if (strip.stillOut.length) {
    console.log(
      `STILL OUT (${strip.outCount}) — solid track colour, left of the divider:\n`,
    );
    for (const b of strip.stillOut) {
      const s = seen.get(b.camera);
      console.log(
        `  cam ${b.camera.padStart(3)}  heat ${String(b.heatNumber ?? "?").padStart(3)} ${String(b.track ?? "?").padEnd(5)}` +
          `  ${formatSinceFlag(b.sinceFlagMs).padEnd(9)} since the flag  ` +
          (s ? `last seen ${et(s)} — BEFORE it` : `never seen today`),
      );
    }
    console.log();
  }
  if (strip.incoming.length) {
    const backN = strip.incoming.filter((b) => b.state === "back").length;
    console.log(`INCOMING (${backN} of ${strip.incoming.length} back) — right of the divider:\n`);
    for (const b of strip.incoming) {
      const s = seen.get(b.camera);
      console.log(
        `  cam ${b.camera.padStart(3)}  heat ${String(b.heatNumber ?? "?").padStart(3)} ${String(b.track ?? "?").padEnd(5)}` +
          `  ${b.state === "back" ? "GREEN" : "grey "}  ` +
          (s && b.state === "back" ? `registered ${et(s)}` : `nothing since the flag`),
      );
    }
    console.log();
  }

  /**
   * WHY EVERY OTHER CAMERA IS ABSENT, split by reason — the two look identical on
   * the wall and mean opposite things, so the tool must not blur them:
   *
   *   cleared      it came back and its next race has been called. Nothing owed.
   *   not yet due  no session it went out on has a finish record, so as far as
   *                this strip knows it is still on track. If that is wrong, the
   *                missing fact is the FLAG, not the camera.
   *
   * Note this script reads finish MARKERS only. The shipped resolver also falls
   * back to Pandora's actualEnd, so a camera listed "not yet due" here can be
   * correctly due on the wall. `flags: N/M` above is the tell.
   */
  const shown = new Set([...strip.stillOut, ...strip.incoming].map((b) => b.camera));
  const absent = cameras.filter((c) => !shown.has(c));
  const noFlag = absent.filter(
    (c) => !scans.some((s) => s.camera === c && finishes.has(s.sessionId)),
  );
  const cleared = absent.filter((c) => !noFlag.includes(c));
  const asc = (a: string, b: string) => Number(a) - Number(b);
  if (cleared.length) {
    console.log(`cleared (came back, next race called): ${cleared.sort(asc).join(", ")}`);
  }
  if (noFlag.length) {
    console.log(
      `not yet due (no finish record for their heat): ${noFlag.sort(asc).join(", ")}` +
        `\n  ${finishes.size}/${sessionIds.length} sessions have one — the rest are running, or the flag never arrived.`,
    );
  }
  if (cleared.length || noFlag.length) console.log();

  // A benched camera handed to a racer anyway: that racer has no video, and
  // nothing else in the estate will ever say so.
  const handedOut = benchRows.filter((b) =>
    raw.some((r) => {
      try {
        return String(JSON.parse(r).sys) === String(b.camera_number);
      } catch {
        return false;
      }
    }),
  );
  if (handedOut.length) {
    console.log(
      `!! BENCHED CAMERAS SCANNED TO A RACER TODAY: ${handedOut.map((b) => b.camera_number).join(", ")}` +
        `\n   Those racers have no video and nothing else will say so.\n`,
    );
  }

  const bridge = await redis.get("vt3:bridge:last-event");
  const kart = await redis.get("kart:bridge:last-event");
  console.log(`bridges — vt3 ${bridge ?? "DEAD"} · kart ${kart ?? "DEAD"}`);
  console.log(`(a dead kart bridge means missing flags, so cameras never come due;`);
  console.log(` a dead vt3 bridge means missing sightings, so they never go green.)\n`);

  await redis.quit();
}

main().catch(async (e) => {
  console.error(e);
  await redis.quit();
  process.exit(1);
});
