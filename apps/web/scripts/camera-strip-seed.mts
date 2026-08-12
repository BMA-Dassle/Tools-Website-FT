/**
 * SEED THE CAMERA RETURN STRIP — run ONCE on the deploy that ships it.
 *
 * WHY THIS IS MANDATORY, NOT A CONVENIENCE. The strip is derived from two keys
 * that only the new code writes:
 *
 *   camera-scan-log:{day}   which cameras went out — written by upsertCameraAssignment
 *   camera-seen:{camera}    when a camera last registered — written by the VT3 webhook
 *
 * On the deploy that introduces them both are empty for the racing day already in
 * progress. The scan log being empty is harmless (the strip says "All in"), but
 * seeding ONLY the scan log is actively harmful: every camera that came back
 * hours ago has no sighting, so the wall fills with red for cameras sitting on
 * the shelf — measured 19 of them on 2026-08-12 — and a board crying wolf on its
 * first night is one staff will learn to ignore. Seed both, or neither.
 *
 * Neither source is invented. The scans have always been in
 * `system-history:{camera}` (that is what the video matcher reads), and the
 * sightings come from Neon `video_decision_log.video_created_at`, which is the
 * same VT3 registration timestamp the live webhook stamp uses.
 *
 * Also the repair tool if either key is lost mid-day: same command, same result.
 *
 * IDEMPOTENT. Scan-log members are built with the SAME field order as
 * `upsertCameraAssignment`, so a re-run ZADDs a byte-identical member and Redis
 * keeps one entry rather than duplicating it — field order is load-bearing,
 * because JSON.stringify key order decides sorted-set member identity. Sightings
 * only ever move forward (an older timestamp is skipped), matching stampCameraSeen.
 *
 * DRY RUN BY DEFAULT — pass --apply to write.
 *
 *   npx tsx scripts/camera-strip-seed.mts                  # today, dry run
 *   npx tsx scripts/camera-strip-seed.mts --apply
 *   DAY=2026-08-11 npx tsx scripts/camera-strip-seed.mts --apply
 *
 * Run from apps/web (reads .env.local from the working directory).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";
import { neon } from "@neondatabase/serverless";

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });
const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

/** Must match lib/camera-assign.ts. */
const SCAN_LOG_TTL_SECONDS = 48 * 60 * 60;
const CAMERA_SEEN_TTL_SECONDS = 48 * 60 * 60;

const et = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: true });

/** Racing business day — 2 AM ET rollover. Mirrors lib/race-business-day.ts. */
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

interface HistoryEntry {
  sessionId?: string | number;
  personId?: string | number;
  firstName?: string;
  lastName?: string;
  systemNumber?: string;
  assignedAt?: string;
}

async function main() {
  const day = process.env.DAY || businessDayYmdET();
  const key = `camera-scan-log:${day}`;
  console.log(`\n=== backfill ${key} ${APPLY ? "(APPLY)" : "(dry run)"} ===\n`);

  const before = await redis.zcard(key);
  console.log(`index currently holds ${before} entries`);

  const histKeys = (await redis.keys("system-history:*")).sort();
  console.log(`scanning ${histKeys.length} per-camera history keys...\n`);

  const members: Array<{ score: number; member: string; cam: string; sid: string }> = [];
  for (const hk of histKeys) {
    const cam = hk.slice("system-history:".length);
    for (const raw of await redis.zrange(hk, 0, -1)) {
      let e: HistoryEntry;
      try {
        e = JSON.parse(raw) as HistoryEntry;
      } catch {
        continue;
      }
      const at = e.assignedAt ? Date.parse(e.assignedAt) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      // Only the target racing day.
      if (businessDayYmdET(new Date(at)) !== day) continue;
      const sys = String(e.systemNumber ?? cam);
      const sid = String(e.sessionId ?? "");
      if (!sys || !sid) continue;
      // FIELD ORDER MUST MATCH upsertCameraAssignment — see the header.
      const member = JSON.stringify({
        sys,
        sid,
        pid: String(e.personId ?? ""),
        fn: e.firstName ?? "",
        ln: e.lastName ?? "",
        at: e.assignedAt,
      });
      members.push({ score: at, member, cam: sys, sid });
    }
  }

  const cameras = new Set(members.map((m) => m.cam));
  const sessions = new Set(members.map((m) => m.sid));
  console.log(
    `found ${members.length} scans on ${day}: ${cameras.size} cameras across ${sessions.size} sessions`,
  );
  if (members.length) {
    const times = members.map((m) => m.score).sort((a, b) => a - b);
    console.log(`  earliest ${et(times[0])}`);
    console.log(`  latest   ${et(times[times.length - 1])}`);
    console.log(`  cameras: ${[...cameras].sort((a, b) => Number(a) - Number(b)).join(", ")}`);
  }

  // ── PHASE 2: the sightings ────────────────────────────────────────
  // Every VT3 registration we have a durable record of. `video_created_at` is
  // the dock/registration moment — the same field the live webhook stamp reads,
  // NOT sampleUploadTime and not the row's own ts.
  console.log(`\n--- sightings from video_decision_log ---`);
  const rows = (await sql`
    SELECT camera_number, system_name, video_created_at
    FROM video_decision_log
    WHERE video_created_at IS NOT NULL AND ts > now() - interval '40 hours'
  `) as Array<{
    camera_number: number | null;
    system_name: string | null;
    video_created_at: string;
  }>;
  const latest = new Map<string, number>();
  for (const r of rows) {
    const at = Date.parse(String(r.video_created_at));
    if (!Number.isFinite(at)) continue;
    // Both keys, exactly as the webhook stamps them.
    for (const k of [r.camera_number, r.system_name].filter((x) => x != null && x !== "")) {
      const cam = String(k);
      latest.set(cam, Math.max(latest.get(cam) ?? 0, at));
    }
  }
  console.log(`${rows.length} rows → ${latest.size} distinct camera keys with a registration`);
  // Only the cameras this day's strip could actually ask about.
  const relevant = [...latest.entries()].filter(([cam]) => cameras.has(cam));
  console.log(`${relevant.length} of them are cameras scanned on ${day}:`);
  for (const [cam, at] of relevant.sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`   cam ${cam.padStart(3)}  last registered ${et(at)}`);
  }
  const noSighting = [...cameras].filter((c) => !latest.has(c));
  if (noSighting.length) {
    console.log(
      `\n${noSighting.length} scanned cameras have NO registration on record and will stay RED` +
        ` if their race has finished: ${noSighting.sort((a, b) => Number(a) - Number(b)).join(", ")}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply.\n`);
    await redis.quit();
    return;
  }

  // ── write phase 1 ─────────────────────────────────────────────────
  if (members.length > 0) {
    // Chunked so a busy day cannot build one enormous command.
    for (let i = 0; i < members.length; i += 200) {
      const p = redis.pipeline();
      for (const m of members.slice(i, i + 200)) p.zadd(key, m.score, m.member);
      await p.exec();
    }
    await redis.expire(key, SCAN_LOG_TTL_SECONDS);
  }
  const after = await redis.zcard(key);
  console.log(`\nscan index now holds ${after} entries (was ${before}, +${after - before} new)`);

  // ── write phase 2 ─────────────────────────────────────────────────
  // Forward-only, matching stampCameraSeen: never move a sighting backwards.
  let wrote = 0;
  let kept = 0;
  for (const [cam, at] of latest) {
    const seenKey = `camera-seen:${cam}`;
    const prev = await redis.get(seenKey);
    const prevMs = prev ? Number(prev) : Number.NaN;
    if (Number.isFinite(prevMs) && prevMs >= at) {
      kept += 1;
      continue;
    }
    await redis.set(seenKey, String(Math.round(at)), "EX", CAMERA_SEEN_TTL_SECONDS);
    wrote += 1;
  }
  console.log(`camera-seen: wrote ${wrote}, left ${kept} newer stamps alone\n`);

  await redis.quit();
}

main().catch(async (e) => {
  console.error(e);
  await redis.quit();
  process.exit(1);
});
