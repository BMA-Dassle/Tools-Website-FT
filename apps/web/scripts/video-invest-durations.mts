/**
 * READ-ONLY probe: is ">5 min = real" a safe junk filter?
 *  1. Fine-grained duration census for matched + unmatched (30s bins to 10min).
 *  2. All matched records 120s-600s listed (the ambiguous band).
 *  3. Junk-theft linkage: dup-held videos whose suggested racer's own matched
 *     record for that same session is SHORT (<300s) = junk stole the slot,
 *     real video went to review.
 * Redis reads only. Run from apps/web: npx tsx scripts/video-invest-durations.mts
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
const etTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-CA", { timeZone: ET, hour12: false }).replace(",", "") : "?";
const startMs = new Date("2026-07-10T00:00:00-04:00").getTime();
const endMs = new Date("2026-07-28T23:59:59-04:00").getTime();
async function mgetChunked(keys: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 400) out.push(...(await redis.mget(...keys.slice(i, i + 400))));
  return out;
}
async function main() {
  const matchIds = await redis.zrevrangebyscore("video-match:log", endMs, startMs);
  const matched: any[] = (await mgetChunked(matchIds.map((id) => `video-match:${id}`)))
    .filter(Boolean).map((r) => JSON.parse(r as string));
  const unCodes = await redis.zrevrangebyscore("video-unmatched:log", endMs, startMs);
  const unmatched: any[] = (await mgetChunked(unCodes.map((c) => `video-unmatched:${c}`)))
    .filter(Boolean).map((r) => JSON.parse(r as string));

  // 1. 30s bins up to 600s, then 600-750, 750+, per corpus + raceType split for matched
  const bin = (d?: number) => {
    if (d == null) return "unk";
    if (d >= 750) return "750+";
    if (d >= 600) return "600-750";
    return `${Math.floor(d / 30) * 30}-${Math.floor(d / 30) * 30 + 30}`;
  };
  const mBins: Record<string, number> = {};
  const uBins: Record<string, number> = {};
  for (const m of matched) mBins[bin(m.duration)] = (mBins[bin(m.duration)] || 0) + 1;
  for (const u of unmatched) uBins[bin(u.duration)] = (uBins[bin(u.duration)] || 0) + 1;
  const order = (o: Record<string, number>) =>
    Object.entries(o).sort((a, b) => {
      const n = (k: string) => (k === "unk" ? 1e9 : k === "750+" ? 750 : parseInt(k));
      return n(a[0]) - n(b[0]);
    });
  console.log("=== MATCHED duration bins (s) ===");
  for (const [k, v] of order(mBins)) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log("=== UNMATCHED duration bins (s) ===");
  for (const [k, v] of order(uBins)) console.log(`  ${k.padEnd(8)} ${v}`);

  // race-type minimums among matched >= 300s (what do real short races look like?)
  const byType: Record<string, number[]> = {};
  for (const m of matched) {
    if (m.duration == null) continue;
    (byType[m.raceType || "?"] ||= []).push(m.duration);
  }
  console.log("\n=== per raceType: n / p5 / median (all durations) ===");
  for (const [t, arr] of Object.entries(byType)) {
    arr.sort((a, b) => a - b);
    const p = (x: number) => arr[Math.floor(x * (arr.length - 1))];
    console.log(`  ${t.padEnd(18)} n=${arr.length}  p5=${p(0.05)}s  median=${p(0.5)}s  min=${arr[0]}s`);
  }

  // 2. matched 120-600s listing
  const band = matched.filter((m) => (m.duration ?? 0) >= 120 && (m.duration ?? 0) < 600)
    .sort((a, b) => (a.duration ?? 0) - (b.duration ?? 0));
  console.log(`\n=== MATCHED 120-600s band: ${band.length} ===`);
  for (const m of band)
    console.log(
      `  ${String(m.duration).padStart(3)}s ${etTime(m.capturedAt)} cam=${m.cameraNumber} ${m.firstName} ${m.lastName} heat=${m.heatNumber} ${m.track ?? ""} ${m.raceType ?? ""} blocked=${m.blocked ? m.blockReason : "-"} viewed=${!!m.viewed} purch=${m.purchaseType ?? "-"} code=${m.videoCode}`,
    );

  // 3. junk-theft linkage
  let theft = 0;
  const samples: string[] = [];
  for (const u of unmatched) {
    if (u.reason !== "duplicate-assignment" || !u.suggested) continue;
    const s = u.suggested;
    const own = matched.find(
      (m) => String(m.sessionId) === String(s.sessionId) && String(m.personId) === String(s.personId),
    );
    if (own && (own.duration ?? 9999) < 300) {
      theft++;
      if (samples.length < 25)
        samples.push(
          `held ${u.videoCode} (${u.duration}s, cap ${etTime(u.capturedAt)}) sugg=${s.firstName} ${s.lastName} heat=${s.heatNumber} — their slot holds ${own.videoCode} (${own.duration}s${own.notifySmsOk ? ", SMS SENT" : ""})`,
        );
    }
  }
  console.log(`\n=== JUNK-THEFT LINKAGE: ${theft} held videos whose suggested racer's slot holds a <300s short ===`);
  samples.forEach((s) => console.log("  " + s));

  await redis.quit();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
