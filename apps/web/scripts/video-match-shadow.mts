/**
 * Local shadow monitor for the video-match hardening
 * (feat/video-match-hardening). READ-ONLY against production Redis +
 * Neon — safe to run any time, from any checkout.
 *
 * Modes:
 *   --replay [--hours N]   Evaluate what the NEW rules (junk
 *                          quarantine + swap) would have done over
 *                          the last N hours (default: since 10 AM ET
 *                          today) of LIVE matches. Run BEFORE merge
 *                          to validate on real traffic.
 *   --watch [--interval S] Loop forever printing per-tick deltas.
 *                          Run AFTER merge to verify: junk-matched
 *                          must stay 0, junk-short review rows
 *                          appear, pending buffer drains, decision
 *                          log fills.
 *
 * Run from apps/web:  npx tsx scripts/video-match-shadow.mts --replay
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });
const ET = "America/New_York";
const JUNK_FLOOR_S = (() => {
  const raw = parseInt(process.env.VIDEO_JUNK_MIN_S || "120", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
})();
const isJunk = (d?: number | null) =>
  typeof d === "number" && Number.isFinite(d) && d < JUNK_FLOOR_S;
const etTime = (iso?: string | number) =>
  iso
    ? new Date(iso).toLocaleString("en-CA", { timeZone: ET, hour12: false }).replace(",", "")
    : "?";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(v) ? v : dflt;
};

async function mgetChunked(keys: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 400) out.push(...(await redis.mget(...keys.slice(i, i + 400))));
  return out;
}

async function loadWindow(startMs: number, endMs: number) {
  const matchIds = await redis.zrevrangebyscore("video-match:log", endMs, startMs);
  const matched: any[] = (await mgetChunked(matchIds.map((id) => `video-match:${id}`)))
    .filter(Boolean)
    .map((r) => JSON.parse(r as string));
  const unCodes = await redis.zrevrangebyscore("video-unmatched:log", endMs, startMs);
  const unmatched: any[] = (await mgetChunked(unCodes.map((c) => `video-unmatched:${c}`)))
    .filter(Boolean)
    .map((r) => JSON.parse(r as string));
  return { matched, unmatched };
}

function tenAmTodayEtMs(): number {
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: ET }));
  const tenAm = new Date(nowEt);
  tenAm.setHours(10, 0, 0, 0);
  const offsetMs = Date.now() - nowEt.getTime();
  return tenAm.getTime() + offsetMs;
}

async function replay() {
  const hours = opt("hours", 0);
  const startMs = hours > 0 ? Date.now() - hours * 3600_000 : tenAmTodayEtMs();
  const endMs = Date.now();
  console.log(
    `=== REPLAY ${etTime(startMs)} → ${etTime(endMs)} ET (junk floor ${JUNK_FLOOR_S}s) ===`,
  );
  const { matched, unmatched } = await loadWindow(startMs, endMs);
  console.log(`corpus: ${matched.length} matched, ${unmatched.length} unmatched/held\n`);

  // 1. junk that got MATCHED (new rules would quarantine these)
  const junkMatched = matched.filter((m) => isJunk(m.duration));
  console.log(`-- would-QUARANTINE (junk matched to racers): ${junkMatched.length}`);
  for (const m of junkMatched) {
    console.log(
      `   ${etTime(m.capturedAt)} cam=${m.cameraNumber ?? "?"} ${m.duration}s -> ${m.firstName} ${m.lastName} heat=${m.heatNumber ?? "?"} smsOk=${!!m.notifySmsOk}${m.notifySmsOk ? "  <-- guest was TEXTED this junk" : ""}`,
    );
  }

  // 2. junk-occupied slots whose real video is sitting in review = would-SWAP
  let wouldSwap = 0;
  for (const u of unmatched) {
    if (u.reason !== "duplicate-assignment" || !u.suggested || isJunk(u.duration)) continue;
    const own = matched.find(
      (m) =>
        String(m.sessionId) === String(u.suggested.sessionId) &&
        String(m.personId) === String(u.suggested.personId),
    );
    if (own && isJunk(own.duration)) {
      wouldSwap++;
      console.log(
        `-- would-SWAP: held ${u.videoCode} (${u.duration}s) replaces junk ${own.videoCode} (${own.duration}s) for ${u.suggested.firstName} ${u.suggested.lastName} heat=${u.suggested.heatNumber ?? "?"}`,
      );
    }
  }
  if (wouldSwap === 0) console.log(`-- would-SWAP: 0 in window`);

  // 3. holds + junk in the unmatched bucket
  const holds = unmatched.filter((u) => u.reason === "duplicate-assignment");
  const junkUnmatched = unmatched.filter((u) => isJunk(u.duration));
  console.log(
    `\n-- review bucket: ${holds.length} duplicate-holds, ${junkUnmatched.length} junk-grade (would carry 'junk clip' chip)`,
  );

  // 4. per-camera junk clusters (flaky hardware watch)
  const perCam: Record<string, number> = {};
  for (const v of [...matched, ...unmatched])
    if (isJunk(v.duration) && v.cameraNumber != null)
      perCam[v.cameraNumber] = (perCam[v.cameraNumber] || 0) + 1;
  const flaky = Object.entries(perCam)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]);
  if (flaky.length)
    console.log(`-- cameras with ≥3 junk clips (bench-check candidates): ${flaky.map(([c, n]) => `cam${c}×${n}`).join(", ")}`);

  // 5. silent no-contact matches (guest can never hear about these)
  const noContact = matched.filter(
    (m) => !m.notifySmsSentAt && !m.notifyEmailSentAt && !m.blocked && !m.pendingNotify,
  );
  console.log(`-- matched but NEVER notified (no contact / silent): ${noContact.length}`);
  for (const m of noContact.slice(0, 15))
    console.log(`   ${etTime(m.capturedAt)} ${m.firstName} ${m.lastName} heat=${m.heatNumber ?? "?"} code=${m.videoCode}`);
}

async function neonTail(sinceMs: number): Promise<string[]> {
  if (!process.env.DATABASE_URL) return ["(no DATABASE_URL — decision-log tail unavailable)"];
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = (await sql`
      SELECT ts, source, event_type, decision, video_code, racer, heat_number, duration_s,
             displaced_code, notify_sms_ok, notify_sms_error
      FROM video_decision_log WHERE ts > ${new Date(sinceMs).toISOString()}::timestamptz
      ORDER BY ts DESC LIMIT 30`) as any[];
    return rows.map(
      (r) =>
        `${etTime(r.ts)} [${r.source}/${r.event_type}] ${r.decision ?? ""} ${r.video_code ?? ""} ${r.racer ?? ""} heat=${r.heat_number ?? "-"} dur=${r.duration_s ?? "-"}s${r.displaced_code ? ` displaced=${r.displaced_code}` : ""}${r.notify_sms_ok === false ? ` SMS-FAIL:${r.notify_sms_error ?? "?"}` : ""}`,
    );
  } catch (err: any) {
    return [`(decision-log tail failed: ${String(err?.message || err).slice(0, 120)})`];
  }
}

async function watch() {
  const intervalS = opt("interval", 60);
  console.log(`=== WATCH mode — every ${intervalS}s. Ctrl-C to stop. Junk floor ${JUNK_FLOOR_S}s ===`);
  let lastTickMs = Date.now() - 15 * 60_000; // first tick looks back 15 min
  for (;;) {
    const now = Date.now();
    const { matched, unmatched } = await loadWindow(lastTickMs, now);
    const junkMatched = matched.filter((m) => isJunk(m.duration));
    const junkShortRows = unmatched.filter((u) => u.reason === "junk-short");
    const holds = unmatched.filter((u) => u.reason === "duplicate-assignment");
    const pendingDepth = await redis.hlen("video-pending:events").catch(() => -1);
    let oldestPendingAge = "-";
    try {
      const all = await redis.hgetall("video-pending:events");
      const ages = Object.values(all || {}).map((raw) => {
        try {
          return now - (JSON.parse(raw).firstReceivedAtMs || now);
        } catch {
          return 0;
        }
      });
      if (ages.length) oldestPendingAge = `${Math.round(Math.max(...ages) / 1000)}s`;
    } catch {}
    console.log(
      `\n[${etTime(now)}] last ${Math.round((now - lastTickMs) / 1000)}s: ` +
        `matched=${matched.length} (JUNK-MATCHED=${junkMatched.length}${junkMatched.length > 0 ? " ⚠ SHOULD BE 0" : ""}) ` +
        `quarantined=${junkShortRows.length} holds=${holds.length} ` +
        `pendingBuffer=${pendingDepth} oldestPending=${oldestPendingAge}`,
    );
    for (const m of matched.slice(0, 12)) {
      console.log(
        `   ${etTime(m.capturedAt)} cam=${m.cameraNumber ?? "?"} ${m.duration ?? "?"}s ${m.firstName} ${m.lastName} heat=${m.heatNumber ?? "?"} ${m.track ?? ""} sms=${m.notifySmsOk ? "ok" : m.notifySmsSentAt ? "fail" : "-"}`,
      );
    }
    for (const line of await neonTail(lastTickMs)) console.log(`   LOG ${line}`);
    lastTickMs = now;
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

async function main() {
  if (flag("watch")) await watch();
  else await replay();
  await redis.quit();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
