/**
 * READ-ONLY: what does the briefing-room camera strip say right now, and why?
 *
 * The command-line twin of the strip along the bottom of the briefing TVs
 * (src/features/signage/briefing/camera-return.ts). Run it when a camera is red
 * and nobody believes it, or green and nobody believes that either — it prints
 * the three facts behind every box, so you can see WHICH of them is missing:
 *
 *   the scan     camera-scan-log:{businessDay}    did staff scan it out?
 *   the flag     briefing:race-finished:{id}      did the bridge tell us the
 *                                                 race ended?
 *   the sighting camera-seen:{camera}             has it registered since?
 *
 *   npx tsx scripts/camera-return-peek.mts            # today
 *   DAY=2026-08-11 npx tsx scripts/camera-return-peek.mts
 *   npx tsx scripts/camera-return-peek.mts --all      # incl. settled cameras
 *
 * Run from apps/web (it reads .env.local from the working directory). NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });
const SHOW_ALL = process.argv.includes("--all");

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

/** Same numbers as the pure module — keep in step with camera-return.ts. */
const GREEN_HOLD_MS = 90_000;
const SEEN_SKEW_MS = 60_000;

function sinceFlag(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function main() {
  const day = process.env.DAY || businessDayYmdET();
  const nowMs = Date.now();
  console.log(`\n=== camera return strip · business day ${day} · ${et(nowMs)} ET ===\n`);

  const raw = await redis.zrange(`camera-scan-log:${day}`, 0, -1, "WITHSCORES");
  if (raw.length === 0) {
    console.log(`camera-scan-log:${day} is EMPTY.`);
    console.log(`  Either no camera has been scanned out yet on this racing day, or the`);
    console.log(`  index write in lib/camera-assign.ts is not deployed. The strip would`);
    console.log(`  show its all-clear line.\n`);
    await redis.quit();
    return;
  }

  interface Scan {
    camera: string;
    sessionId: string;
    assignedAtMs: number;
    racer: string;
  }
  const scans: Scan[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    try {
      const e = JSON.parse(raw[i]);
      const at = Date.parse(String(e.at ?? "")) || Number(raw[i + 1]);
      if (!e.sys || !e.sid || !Number.isFinite(at)) continue;
      scans.push({
        camera: String(e.sys),
        sessionId: String(e.sid),
        assignedAtMs: at,
        racer: `${e.fn ?? ""} ${e.ln ?? ""}`.trim(),
      });
    } catch {
      /* skip */
    }
  }
  console.log(`${scans.length} scans, ${new Set(scans.map((s) => s.camera)).size} distinct cameras\n`);

  const sessionIds = [...new Set(scans.map((s) => s.sessionId))];
  const markers = new Map<string, { endedAtMs: number; heatNumber: number | null; heatName?: string }>();
  const markerRaws = await redis.mget(...sessionIds.map((s) => `briefing:race-finished:${s}`));
  markerRaws.forEach((v, i) => {
    if (!v) return;
    try {
      const m = JSON.parse(v);
      if (Number.isFinite(m.endedAtMs)) markers.set(sessionIds[i], m);
    } catch {
      /* skip */
    }
  });

  const cameras = [...new Set(scans.map((s) => s.camera))];
  const seen = new Map<string, number>();
  const seenRaws = await redis.mget(...cameras.map((c) => `camera-seen:${c}`));
  seenRaws.forEach((v, i) => {
    if (!v) return;
    const ms = Number(v);
    if (Number.isFinite(ms)) seen.set(cameras[i], ms);
  });

  console.log(
    `finish markers: ${markers.size}/${sessionIds.length} sessions   sightings: ${seen.size}/${cameras.length} cameras\n`,
  );

  // Same decision as the pure module, spelled out per scan so the reason shows.
  const rows: Array<{ cam: string; verdict: string; detail: string; sortAt: number }> = [];
  const openByCam = new Map<string, Scan & { endedAtMs: number; heatNumber: number | null }>();
  const doneByCam = new Map<string, Scan & { endedAtMs: number; seenAtMs: number }>();

  for (const s of scans) {
    const mk = markers.get(s.sessionId);
    if (!mk) {
      if (SHOW_ALL) {
        rows.push({
          cam: s.camera,
          verdict: "not shown",
          detail: `session ${s.sessionId} has NO finish marker — still racing, or the bridge dropped it`,
          sortAt: s.assignedAtMs,
        });
      }
      continue;
    }
    const seenAtMs = seen.get(s.camera);
    const settled = seenAtMs != null && seenAtMs >= mk.endedAtMs - SEEN_SKEW_MS;
    if (settled) {
      const prev = doneByCam.get(s.camera);
      if (!prev || s.assignedAtMs > prev.assignedAtMs) {
        doneByCam.set(s.camera, { ...s, endedAtMs: mk.endedAtMs, seenAtMs: seenAtMs! });
      }
    } else {
      const prev = openByCam.get(s.camera);
      if (!prev || s.assignedAtMs < prev.assignedAtMs) {
        openByCam.set(s.camera, { ...s, endedAtMs: mk.endedAtMs, heatNumber: mk.heatNumber ?? null });
      }
    }
  }

  for (const [cam, s] of openByCam) {
    rows.push({
      cam,
      verdict: "RED",
      detail:
        `heat ${s.heatNumber ?? "?"} flagged ${et(s.endedAtMs)} (${sinceFlag(nowMs - s.endedAtMs)} ago), ` +
        (seen.has(cam)
          ? `last seen ${et(seen.get(cam)!)} — BEFORE the flag`
          : `never seen today`) +
        (s.racer ? `  · was ${s.racer}` : ""),
      sortAt: s.assignedAtMs,
    });
  }
  for (const [cam, s] of doneByCam) {
    if (openByCam.has(cam)) continue;
    const holding = nowMs - s.seenAtMs <= GREEN_HOLD_MS;
    if (!holding && !SHOW_ALL) continue;
    rows.push({
      cam,
      verdict: holding ? "GREEN" : "settled",
      detail: `registered ${et(s.seenAtMs)}${holding ? ` — green for another ${Math.round((GREEN_HOLD_MS - (nowMs - s.seenAtMs)) / 1000)}s` : " — off the strip"}`,
      sortAt: s.assignedAtMs,
    });
  }

  rows.sort((a, b) => a.sortAt - b.sortAt || Number(a.cam) - Number(b.cam));
  const onStrip = rows.filter((r) => r.verdict === "RED" || r.verdict === "GREEN");
  if (onStrip.length === 0) {
    console.log(`THE STRIP IS CLEAR — it would show "All in".\n`);
  } else {
    console.log(`ON THE STRIP (left to right), ${openByCam.size} still out:\n`);
  }
  for (const r of rows) {
    console.log(`  ${r.verdict.padEnd(9)} cam ${r.cam.padStart(3)}  ${r.detail}`);
  }

  const bridge = await redis.get("vt3:bridge:last-event");
  const kart = await redis.get("kart:bridge:last-event");
  console.log(`\nbridges — vt3 ${bridge ?? "DEAD"} · kart ${kart ?? "DEAD"}`);
  console.log(`(a dead kart bridge means missing finish markers, so cameras never go red;`);
  console.log(` a dead vt3 bridge means missing sightings, so they never go green.)\n`);

  await redis.quit();
}

main().catch(async (e) => {
  console.error(e);
  await redis.quit();
  process.exit(1);
});
