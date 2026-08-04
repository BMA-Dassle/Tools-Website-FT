/**
 * READ-ONLY follow-up probe:
 *  A. Full match/unmatched reconstruction for specific sessions:
 *     - 55861225 (Blue heat 46, 7/25 — May family wrong-video cluster)
 *     - 55861238 (Blue heat 59, 7/25 — Jessica's correct 2nd)
 *     - 55725722 / 55725726 (Red heats 36/38, 7/24 — crash blocks + Brightwell)
 *     - 54064278 (Blue heat 32, 7/17 — Mazzeo)
 *  B. VT3 expiry window: for unmatched records with videoStatus=EXPIRED,
 *     days between capturedAt and lastWebhookEventAt (upper bound on expiry).
 *  C. Camera-number collision census: same cameraNumber appearing under
 *     multiple stations the same day (dock roaming).
 * Redis: ZREVRANGEBYSCORE/MGET/GET only. NO WRITES.
 * Run from apps/web: npx tsx scripts/video-invest-sessions.mts
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
    .filter(Boolean)
    .map((r) => JSON.parse(r as string));
  const unCodes = await redis.zrevrangebyscore("video-unmatched:log", endMs, startMs);
  const unmatched: any[] = (await mgetChunked(unCodes.map((c) => `video-unmatched:${c}`)))
    .filter(Boolean)
    .map((r) => JSON.parse(r as string));

  // A. session reconstructions
  const SESSIONS = ["55861225", "55861238", "55725722", "55725726", "54064278"];
  for (const sid of SESSIONS) {
    const rows = matched.filter((m) => String(m.sessionId) === sid);
    console.log(`\n=== SESSION ${sid} (${rows[0]?.sessionName ?? "?"} ${rows[0] ? etTime(rows[0].scheduledStart) : ""}) — ${rows.length} matched ===`);
    for (const m of rows.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : 1))) {
      console.log(
        `  cam=${m.cameraNumber ?? "?"} sys=${m.systemNumber} cap=${etTime(m.capturedAt)} dur=${m.duration}s ${m.firstName} ${m.lastName}  sms=${m.notifySmsOk ? "ok" : "-"}/${m.notifySmsDeliveryStatus ?? "-"} email=${m.notifyEmailOk ? "ok" : "-"} viewed=${!!m.viewed} purch=${m.purchaseType ?? "-"} blocked=${m.blocked ? m.blockReason : "-"} status=${m.videoStatus} code=${m.videoCode}`,
      );
    }
  }

  // B. expiry window
  const deltas: number[] = [];
  for (const u of unmatched) {
    if (u.videoStatus === "EXPIRED" && u.capturedAt && u.lastWebhookEventAt) {
      const d = (new Date(u.lastWebhookEventAt).getTime() - new Date(u.capturedAt).getTime()) / 86400000;
      if (d > 0 && d < 40) deltas.push(d);
    }
  }
  deltas.sort((a, b) => a - b);
  const q = (p: number) => deltas[Math.floor(p * (deltas.length - 1))]?.toFixed(1);
  console.log(`\n=== VT3 EXPIRED-event delta (capture -> last EXPIRED webhook), n=${deltas.length} ===`);
  console.log(`min=${q(0)}d p25=${q(0.25)}d median=${q(0.5)}d p75=${q(0.75)}d max=${q(1)}d`);

  // C. camera roaming across stations per ET day
  const seen: Record<string, Set<string>> = {};
  for (const m of matched) {
    if (m.cameraNumber == null) continue;
    const day = new Date(m.capturedAt).toLocaleDateString("en-CA", { timeZone: ET });
    const k = `${day} cam${m.cameraNumber}`;
    (seen[k] ||= new Set()).add(String(m.systemNumber));
  }
  const roaming = Object.entries(seen).filter(([, s]) => s.size > 1);
  console.log(`\n=== CAMERA ROAMING (same camera, >1 station, same day): ${roaming.length} camera-days ===`);
  for (const [k, s] of roaming.slice(0, 25)) console.log(`  ${k}: stations ${[...s].join(", ")}`);

  await redis.quit();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
