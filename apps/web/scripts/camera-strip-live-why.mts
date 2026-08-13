/**
 * READ-ONLY: what is the WALL actually showing, and why is each box there?
 *
 * WHY THIS EXISTS ALONGSIDE camera-return-peek.mts: the peek rebuilds the strip
 * from Redis facts ONLY. The shipped server path (camera-return.server.ts) also
 * applies the mandatory Pandora `actualEnd` backstop for every session with no
 * `briefing:race-finished` marker. So on a night when the kart bridge is dropping
 * pushes — which is most of them — the peek says "all in" while the wall shows a
 * chase list. This reads the cache the wall itself renders, so there is no drift.
 *
 *   npx tsx scripts/camera-strip-live-why.mts
 *
 * NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });

const et = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: true });

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

const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m} min`;
};

interface Box {
  camera: string;
  state: string;
  heatNumber: number | null;
  track: string | null;
  sinceFlagMs: number;
  assignedAtMs: number;
}

async function main() {
  const nowMs = Date.now();
  const day = businessDayYmdET(new Date(nowMs));
  console.log(`\n=== WHAT THE WALL IS SHOWING · ${day} · ${et(nowMs)} ET ===\n`);

  // ── the wall's own cached strip ──────────────────────────────────────
  const keys = await redis.keys("camera-return:strip:*");
  if (keys.length === 0) {
    console.log("No cached strip. Either no TV has polled in the last 3s, or the");
    console.log("kill switch SIGNAGE_CAMERA_RETURN_ENABLED is off.\n");
    await redis.quit();
    return;
  }

  // ONE READ, REUSED. The wall's cache is a 3-second TTL, so re-GETting the key
  // to print detail after printing the summary races the expiry and blows up on
  // a null — which it did, first run.
  type Feed = { stillOut: Box[]; incoming: Box[]; outCount: number; stale?: boolean };
  let feed: Feed | null = null;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const f = JSON.parse(raw) as Feed;
    if (!feed) feed = f;
    console.log(
      `${key}  →  ${f.outCount} still out, ${f.incoming.length} incoming${f.stale ? "  [STALE]" : ""}`,
    );
  }
  console.log();
  if (!feed) {
    console.log("The cached strip expired mid-read (3s TTL). Run it again.\n");
    await redis.quit();
    return;
  }

  // ── the scans, for racer + session behind each box ───────────────────
  const raw = await redis.zrange(`camera-scan-log:${day}`, 0, -1);
  const scans = new Map<string, Array<{ sid: string; at: number; who: string }>>();
  for (const r of raw) {
    try {
      const e = JSON.parse(r);
      const at = Date.parse(String(e.at ?? ""));
      if (!e.sys || !e.sid || !Number.isFinite(at)) continue;
      const cam = String(e.sys);
      if (!scans.has(cam)) scans.set(cam, []);
      scans.get(cam)!.push({ sid: String(e.sid), at, who: `${e.fn ?? ""} ${e.ln ?? ""}`.trim() });
    } catch {
      /* skip */
    }
  }

  const all = [...feed.stillOut, ...feed.incoming];
  const seenRaws = all.length
    ? await redis.mget(...all.map((b) => `camera-seen:${b.camera}`))
    : [];
  const seen = new Map<string, number>();
  all.forEach((b, i) => {
    const v = seenRaws[i];
    if (v && Number.isFinite(Number(v))) seen.set(b.camera, Number(v));
  });

  const markers = new Map<string, boolean>();
  const sids = [...new Set([...scans.values()].flat().map((s) => s.sid))];
  if (sids.length) {
    const mk = await redis.mget(...sids.map((s) => `briefing:race-finished:${s}`));
    sids.forEach((s, i) => markers.set(s, mk[i] != null));
  }

  const line = (b: Box) => {
    // Match the box back to the scan that produced it; fall back to the newest
    // scan of that camera if the exact stamp is not in today's log.
    const mine = [...(scans.get(b.camera) ?? [])].sort((x, y) => y.at - x.at);
    const scan = mine.find((s) => s.at === b.assignedAtMs) ?? mine[0];
    const s = seen.get(b.camera);
    const flagMs = nowMs - b.sinceFlagMs;
    console.log(
      `  cam ${b.camera.padStart(3)}  ${String(b.track ?? "?").padEnd(5)} heat ${String(b.heatNumber ?? "?").padStart(3)}  ` +
        `out ${dur(b.sinceFlagMs)} since the flag (${et(flagMs)})`,
    );
    console.log(
      `           scanned out ${scan ? et(scan.at) : "?"}${scan?.who ? ` to ${scan.who}` : ""}` +
        `  ·  session ${scan?.sid ?? "?"}${scan ? (markers.get(scan.sid) ? " [bridge flag]" : " [NO bridge flag — Pandora actualEnd]") : ""}`,
    );
    console.log(
      `           last sighting ${s ? `${et(s)} — ${s >= flagMs ? "AFTER" : "BEFORE"} the flag` : "NEVER SEEN TODAY"}`,
    );
  };

  if (feed.stillOut.length) {
    console.log(`STILL OUT (${feed.outCount}) — the chase list:\n`);
    feed.stillOut.forEach(line);
    console.log();
  }
  if (feed.incoming.length) {
    console.log(`INCOMING (${feed.incoming.length}) — just off track:\n`);
    feed.incoming.forEach(line);
    console.log();
  }

  const hb = await redis.mget("vt3:bridge:last-event", "kart:bridge:last-event");
  const age = (s: string | null) =>
    s ? `${Math.round((nowMs - Date.parse(s)) / 60_000)} min stale` : "DEAD";
  console.log(`bridges — vt3 ${hb[0] ?? "DEAD"} (${age(hb[0])})`);
  console.log(`          kart ${hb[1] ?? "DEAD"} (${age(hb[1])})`);
  console.log(`  A dead kart bridge means no race-finished markers, so every finish time`);
  console.log(`  on the strip above is Pandora's actualEnd fallback instead of the flag.`);
  await redis.quit();
}

main().catch(async (e) => {
  console.error(e);
  await redis.quit();
  process.exit(1);
});
