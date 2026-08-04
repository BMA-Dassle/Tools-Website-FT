/**
 * READ-ONLY forensics for the POV video complaints (7/14–7/26 chat transcript).
 *
 * Pulls every matched + unmatched video record still inside the 30-day Redis
 * TTL for the window 7/10–7/28, then:
 *   1. Per-day counts: matched / unmatched / duplicate-assignment holds,
 *      notify outcomes, carrier delivery, pendingNotify stuck, blocked,
 *      guardian-routed, contactless rows.
 *   2. Duration histogram (junk short-video hypothesis) matched vs unmatched.
 *   3. Per-system burst detection (undocked camera batch uploads): videos on
 *      the same system with near-identical capture times or overlapping
 *      capture windows.
 *   4. Full record dumps for every named guest in the complaint transcript.
 *
 * Redis ops used: ZREVRANGEBYSCORE / MGET / GET only. NO WRITES.
 * Run from apps/web:  npx tsx scripts/video-invest-cases.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";
/* eslint-disable @typescript-eslint/no-explicit-any */

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });

const ET = "America/New_York";
const startMs = new Date("2026-07-10T00:00:00-04:00").getTime();
const endMs = new Date("2026-07-28T23:59:59-04:00").getTime();

const etDay = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: ET }) : "?";
const etTime = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("en-CA", { timeZone: ET, hour12: false }).replace(",", "")
    : "?";

async function mgetChunked(keys: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    out.push(...(await redis.mget(...chunk)));
  }
  return out;
}

async function loadAll() {
  // Matched: log member = `${sessionId}:${personId}`, score = matchedAt ms
  const matchIds = await redis.zrevrangebyscore("video-match:log", endMs, startMs);
  const matchedRaw = await mgetChunked(matchIds.map((id) => `video-match:${id}`));
  const matched: any[] = [];
  let matchedExpired = 0;
  matchedRaw.forEach((raw) => {
    if (!raw) return void matchedExpired++;
    try {
      matched.push(JSON.parse(raw));
    } catch {}
  });

  // Unmatched: log member = videoCode, score = capturedAt ms
  const unCodes = await redis.zrevrangebyscore("video-unmatched:log", endMs, startMs);
  const unRaw = await mgetChunked(unCodes.map((c) => `video-unmatched:${c}`));
  const unmatched: any[] = [];
  let unmatchedExpired = 0;
  unRaw.forEach((raw) => {
    if (!raw) return void unmatchedExpired++;
    try {
      unmatched.push(JSON.parse(raw));
    } catch {}
  });
  return { matched, matchedExpired, unmatched, unmatchedExpired, matchIds, unCodes };
}

function bucketDuration(d?: number): string {
  if (d == null) return "unknown";
  if (d < 30) return "<30s";
  if (d < 120) return "30-120s";
  if (d < 300) return "2-5min";
  if (d < 600) return "5-10min";
  return ">10min";
}

const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] || 0) + 1);
const sortObj = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

async function main() {
  const { matched, matchedExpired, unmatched, unmatchedExpired } = await loadAll();
  console.log(`=== CORPUS 7/10–7/28 ===`);
  console.log(
    `matched: ${matched.length} (+${matchedExpired} log entries whose record TTL'd out)`,
  );
  console.log(
    `unmatched: ${unmatched.length} (+${unmatchedExpired} log entries whose record TTL'd out)`,
  );
  console.log(`vt3:last-seen-id = ${await redis.get("vt3:last-seen-id")}`);

  // ---------- 1. per-day aggregates ----------
  const perDay: Record<string, any> = {};
  const day = (iso?: string) => {
    const k = etDay(iso);
    perDay[k] ||= {
      matched: 0,
      unmatched: 0,
      dupHold: 0,
      smsOk: 0,
      smsFail: 0,
      emailOk: 0,
      noContact: 0,
      viaGuardian: 0,
      pendingNotify: 0,
      blocked: 0,
      dlrDelivered: 0,
      dlrUndelivered: 0,
    };
    return perDay[k];
  };
  const smsErrors: Record<string, number> = {};
  const dlr: Record<string, number> = {};
  for (const m of matched) {
    const d = day(m.capturedAt || m.matchedAt);
    d.matched++;
    if (m.notifySmsOk) d.smsOk++;
    else if (m.notifySmsError) {
      d.smsFail++;
      inc(smsErrors, String(m.notifySmsError).slice(0, 90));
    }
    if (m.notifyEmailOk) d.emailOk++;
    if (!m.phone && !m.mobilePhone && !m.homePhone && !m.email && !m.guardian) d.noContact++;
    if (m.viaGuardian) d.viaGuardian++;
    if (m.pendingNotify) d.pendingNotify++;
    if (m.blocked) d.blocked++;
    if (m.notifySmsDeliveryStatus) {
      inc(dlr, m.notifySmsDeliveryStatus);
      if (m.notifySmsDeliveryStatus === "delivered") d.dlrDelivered++;
      if (m.notifySmsDeliveryStatus === "undelivered" || m.notifySmsDeliveryStatus === "failed")
        d.dlrUndelivered++;
    }
  }
  for (const u of unmatched) {
    const d = day(u.capturedAt || u.matchedAt);
    d.unmatched++;
    if (u.reason === "duplicate-assignment") d.dupHold++;
  }
  console.log(`\n=== PER-DAY (ET) ===`);
  for (const [k, v] of Object.entries(sortObj(perDay as any)) as any) {
    console.log(
      `${k}  matched=${v.matched} unmatched=${v.unmatched} (dupHold=${v.dupHold})  smsOk=${v.smsOk} smsFail=${v.smsFail} emailOk=${v.emailOk}  dlr+${v.dlrDelivered}/-${v.dlrUndelivered}  pending=${v.pendingNotify} blocked=${v.blocked} guardian=${v.viaGuardian} noContact=${v.noContact}`,
    );
  }
  console.log(`\nSMS error strings:`, sortObj(smsErrors));
  console.log(`Carrier DLR overall:`, sortObj(dlr));

  // ---------- 2. duration histograms ----------
  const durM: Record<string, number> = {};
  const durU: Record<string, number> = {};
  for (const m of matched) inc(durM, bucketDuration(m.duration));
  for (const u of unmatched) inc(durU, bucketDuration(u.duration));
  console.log(`\n=== DURATION (junk-video hypothesis) ===`);
  console.log(`matched:  `, sortObj(durM));
  console.log(`unmatched:`, sortObj(durU));
  // Short videos that were MATCHED to a racer = junk consuming a real slot
  const shortMatched = matched.filter((m) => (m.duration ?? 9999) < 120);
  console.log(`\nMatched-but-short (<120s) — junk likely stole a racer slot: ${shortMatched.length}`);
  for (const m of shortMatched.slice(0, 40)) {
    console.log(
      `  ${etTime(m.capturedAt)} sys=${m.systemNumber} dur=${m.duration}s -> ${m.firstName} ${m.lastName} heat=${m.heatNumber ?? "?"} ${m.track ?? ""} code=${m.videoCode} smsOk=${!!m.notifySmsOk} purchased=${!!m.purchased}`,
    );
  }

  // ---------- 3. per-system burst / batch-upload detection ----------
  type V = { capturedAt: string; duration?: number; code: string; kind: string; who?: string };
  const bySys: Record<string, V[]> = {};
  for (const m of matched)
    (bySys[m.systemNumber] ||= []).push({
      capturedAt: m.capturedAt,
      duration: m.duration,
      code: m.videoCode,
      kind: "matched",
      who: `${m.firstName} ${m.lastName}`,
    });
  for (const u of unmatched)
    (bySys[u.systemNumber] ||= []).push({
      capturedAt: u.capturedAt,
      duration: u.duration,
      code: u.videoCode,
      kind: u.reason === "duplicate-assignment" ? "dup-hold" : "unmatched",
    });
  let burstGroups = 0;
  const burstSamples: string[] = [];
  for (const [sys, vids] of Object.entries(bySys)) {
    vids.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    for (let i = 1; i < vids.length; i++) {
      const prev = vids[i - 1];
      const cur = vids[i];
      const gapS = (new Date(cur.capturedAt).getTime() - new Date(prev.capturedAt).getTime()) / 1000;
      // same camera can't legitimately start a new race <120s after the
      // previous START (races are minutes long) — and a gap smaller than the
      // previous video's duration means overlapping capture = batch upload
      if (gapS < 120 || (prev.duration != null && gapS < prev.duration)) {
        burstGroups++;
        if (burstSamples.length < 30)
          burstSamples.push(
            `sys=${sys} ${etTime(prev.capturedAt)} (${prev.duration ?? "?"}s ${prev.kind} ${prev.who ?? ""} ${prev.code}) -> +${Math.round(gapS)}s ${cur.kind} ${cur.who ?? ""} ${cur.code} (${cur.duration ?? "?"}s)`,
          );
      }
    }
  }
  console.log(`\n=== BURSTS (same system, gap<120s or overlapping) : ${burstGroups} pairs ===`);
  burstSamples.forEach((s) => console.log("  " + s));

  // ---------- 4. named-case dumps ----------
  const CASES: Array<[string, string]> = [
    ["nina", "ortega"],
    ["dakota", "corcoran"],
    ["jonathan", "cameron"],
    ["lennox", "nelson"],
    ["valentina", "mazzeo"],
    ["danny", "mazzeo"],
    ["hunter", "may"],
    ["jessica", "may"],
    ["julio", "rodriguez"],
    ["olivia", "brightwell"],
    ["orren", "lay"],
    ["christina", "lay"],
    ["robert", "points"],
    ["janelle", "jelonek"],
    ["bill", "mabe"],
    ["riley", "townsend"],
    ["jose", "garza"],
    ["eric", "williams"],
    ["xavier", "william"],
    ["amanda", "king"],
    ["liv", "smith"],
    ["jody", "young"],
    ["alisson", "portillo"],
    ["sohan", "patel"],
  ];
  const norm = (s?: string) => (s || "").toLowerCase().trim();
  console.log(`\n=== NAMED CASES (full records) ===`);
  for (const [fn, ln] of CASES) {
    const hits = matched.filter(
      (m) => norm(m.firstName).startsWith(fn) && norm(m.lastName).startsWith(ln),
    );
    const sugg = unmatched.filter(
      (u) =>
        u.suggested && norm(u.suggested.firstName).startsWith(fn) && norm(u.suggested.lastName).startsWith(ln),
    );
    if (hits.length === 0 && sugg.length === 0) {
      console.log(`\n--- ${fn} ${ln}: NO RECORDS in window`);
      continue;
    }
    console.log(`\n--- ${fn} ${ln}: ${hits.length} matched, ${sugg.length} unmatched-suggested`);
    for (const h of hits) console.log(JSON.stringify(h));
    for (const s of sugg) console.log("UNMATCHED-SUGG: " + JSON.stringify(s));
  }

  // ---------- 5. unmatched inventory around case days ----------
  console.log(`\n=== UNMATCHED / HELD detail (all ${unmatched.length}) ===`);
  for (const u of unmatched.sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  )) {
    console.log(
      `${etTime(u.capturedAt)} sys=${u.systemNumber} dur=${u.duration ?? "?"}s reason=${u.reason ?? "no-assignment"} code=${u.videoCode} status=${u.videoStatus ?? "?"} sample=${u.sampleUploadTime ? "y" : "n"} viewed=${!!u.viewed} purchased=${!!u.purchased}` +
        (u.suggested
          ? ` sugg=${u.suggested.firstName} ${u.suggested.lastName} heat=${u.suggested.heatNumber ?? "?"} ${u.suggested.track ?? ""}`
          : ""),
    );
  }

  await redis.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
