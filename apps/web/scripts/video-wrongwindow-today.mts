/**
 * READ-ONLY wrong-footage watch — prints one line per matched video whose
 * footage window (created_at − duration) fails midpoint-or-containment
 * against its labeled heat's ACTUAL window (same math as the merged-PR
 * plausibility gate; standalone here so it runs on main pre-merge).
 *
 * Usage (from apps/web):
 *   npx tsx scripts/video-wrongwindow-today.mts             # today ET
 *   npx tsx scripts/video-wrongwindow-today.mts 2026-08-10
 *   npx tsx scripts/video-wrongwindow-today.mts 2026-08-10 --detail coolie,2392380692
 *
 * Output lines are stable + sorted (WRONG <code> ...) so a watch loop can
 * diff runs and emit only new ones.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";
/* eslint-disable @typescript-eslint/no-explicit-any */

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const ET = "America/New_York";
const PRE = 270_000;
const POST = 210_000;

const DAY =
  process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])
    ? process.argv[2]
    : new Date().toLocaleDateString("en-CA", { timeZone: ET });
const detailArgIdx = process.argv.indexOf("--detail");
const detailTerms =
  detailArgIdx > -1 && process.argv[detailArgIdx + 1]
    ? process.argv[detailArgIdx + 1].toLowerCase().split(",")
    : [];

function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/([:[,]\s*)(\d{15,})(\s*[,}\]])/g, '$1"$2"$3'));
}
const etDay = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: ET }) : "?";
const hm = (msOrIso: number | string) =>
  new Date(msOrIso).toLocaleTimeString("en-US", {
    timeZone: ET,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

async function main() {
  const bySession = new Map<string, { aStart: number; aEnd: number } | null>();
  const heatName = new Map<string, string>();
  const qs = `startDate=${encodeURIComponent(`${DAY}T00:00:00`)}&endDate=${encodeURIComponent(`${DAY}T23:59:59`)}`;
  for (const track of ["Red Track", "Blue Track"]) {
    const res = await fetch(
      `${PANDORA}/bmi/sessions/${LOC}?${qs}&resourceName=${encodeURIComponent(track)}`,
      { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } },
    );
    if (!res.ok) {
      console.log(`WATCH-ERROR Pandora ${res.status} for ${track}`);
      continue;
    }
    for (const s of parseRawIds(await res.text())?.data ?? []) {
      const aStart = s.actualStart ? new Date(s.actualStart).getTime() : NaN;
      const aEnd = s.actualEnd ? new Date(s.actualEnd).getTime() : NaN;
      bySession.set(
        String(s.sessionId),
        Number.isFinite(aStart) && Number.isFinite(aEnd) ? { aStart, aEnd } : null,
      );
      heatName.set(String(s.sessionId), `${track.replace(" Track", "")} h${s.heatNumber}`);
    }
  }

  const startMs = new Date(`${DAY}T00:00:00-04:00`).getTime();
  const endMs = startMs + 30 * 60 * 60 * 1000;
  const ids = await redis.zrevrangebyscore("video-match:log", endMs, startMs);
  const matched: any[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const raws = await redis.mget(...ids.slice(i, i + 400).map((id: string) => `video-match:${id}`));
    for (const raw of raws) {
      if (!raw) continue;
      try {
        matched.push(JSON.parse(raw));
      } catch {}
    }
  }
  const corpus = matched.filter((m) => etDay(m.capturedAt) === DAY && m.sessionId);

  const lines: string[] = [];
  for (const m of corpus) {
    const w = bySession.get(String(m.sessionId));
    if (!w) continue; // no actuals (yet) — judged on a later pass
    const end = new Date(m.capturedAt).getTime();
    if (typeof m.duration !== "number" || !Number.isFinite(end)) continue;
    const start = end - m.duration * 1000;
    const lo = w.aStart - PRE;
    const hi = w.aEnd + POST;
    const mid = (start + end) / 2;
    const ok = (mid >= lo && mid <= hi) || (start <= lo && end >= hi);
    if (!ok) {
      lines.push(
        `WRONG ${m.videoCode} ${hm(m.capturedAt)} cam=${m.cameraNumber ?? "?"} ${m.firstName} ${m.lastName} labeled=[${m.track ?? "?"} h${m.heatNumber ?? "?"}] footage=${hm(start)}-${hm(end)} sms=${m.notifySmsOk ?? "-"} dlr=${m.notifySmsDeliveryStatus ?? "-"} viewed=${!!m.viewed}`,
      );
    }
  }
  lines.sort();
  console.log(`WATCH ${DAY} matched=${corpus.length} wrong=${lines.length}`);
  for (const l of lines) console.log(l);

  // ── optional per-guest detail: their record, their camera's day, and
  //    which video actually holds their heat's window ──
  if (detailTerms.length) {
    const hits = corpus.filter((m) =>
      detailTerms.some((t) => {
        const digits = t.replace(/\D/g, "");
        const phones = [m.phone, m.mobilePhone, m.homePhone, m.notifySmsSentTo]
          .map((p) => String(p || "").replace(/\D/g, ""))
          .filter(Boolean);
        return (
          String(m.firstName || "").toLowerCase().includes(t) ||
          String(m.lastName || "").toLowerCase().includes(t) ||
          (digits.length >= 7 && phones.some((p) => p.includes(digits)))
        );
      }),
    );
    for (const h of hits) {
      console.log(`\nDETAIL ${h.firstName} ${h.lastName} [${heatName.get(String(h.sessionId)) ?? "?"}] sid=${h.sessionId} pid=${h.personId}`);
      console.log(`  got code=${h.videoCode} cam=${h.cameraNumber} docked=${hm(h.capturedAt)} dur=${h.duration}s sms=${h.notifySmsOk}→${h.notifySmsSentTo ?? "?"} dlr=${h.notifySmsDeliveryStatus ?? "-"}`);
      const w = bySession.get(String(h.sessionId));
      if (w) {
        console.log(`  their heat actually ran ${hm(w.aStart)}-${hm(w.aEnd)}`);
        // every video today whose footage window covers their heat
        for (const m of corpus) {
          const end = new Date(m.capturedAt).getTime();
          if (typeof m.duration !== "number" || !Number.isFinite(end)) continue;
          const start = end - m.duration * 1000;
          const mid = (start + end) / 2;
          if ((mid >= w.aStart - PRE && mid <= w.aEnd + POST) || (start <= w.aStart - PRE && end >= w.aEnd + POST)) {
            console.log(
            `  heat-window video: code=${m.videoCode} cam=${m.cameraNumber} matched-to=${m.firstName} ${m.lastName} [${m.track ?? "?"} h${m.heatNumber ?? "?"}] footage=${hm(start)}-${hm(end)}`,
            );
          }
        }
        // unmatched/held videos covering their heat
        const unCodes = await redis.zrevrangebyscore("video-unmatched:log", endMs, startMs);
        for (let i = 0; i < unCodes.length; i += 400) {
          const raws = await redis.mget(...unCodes.slice(i, i + 400).map((c: string) => `video-unmatched:${c}`));
          for (const raw of raws) {
            if (!raw) continue;
            let u: any;
            try {
              u = JSON.parse(raw);
            } catch {
              continue;
            }
            const end = new Date(u.capturedAt).getTime();
            if (typeof u.duration !== "number" || !Number.isFinite(end)) continue;
            const start = end - u.duration * 1000;
            const mid = (start + end) / 2;
            if (mid >= w.aStart - PRE && mid <= w.aEnd + POST) {
              console.log(
                `  heat-window HELD video: code=${u.videoCode} cam=${u.cameraNumber} reason=${u.reason ?? "no-assignment"} footage=${hm(start)}-${hm(end)}${u.suggested ? ` sugg=${u.suggested.firstName} ${u.suggested.lastName}` : ""}`,
              );
            }
          }
        }
      }
    }
    if (!hits.length) console.log(`\nDETAIL: no matched record found for ${detailTerms.join(",")}`);
  }

  await redis.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error("WATCH-ERROR", e?.message ?? e);
  process.exit(1);
});
