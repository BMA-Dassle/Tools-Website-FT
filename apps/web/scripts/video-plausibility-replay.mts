/**
 * READ-ONLY replay regression for the plausibility gate (lib/video-plausibility.ts).
 *
 * Runs the REAL shipped verdict function over a full day's matched-video
 * corpus (default 2026-08-09 — the W57384 VIP incident day) and reports
 * what the gate would have done. Expected on 8/9:
 *
 *   plausible   447  (446 true matches + 1 long multi-heat recording the
 *                     containment clause protects)
 *   implausible  94  (the day's wrong-footage deliveries, incl. the 12
 *                     edge-clip cases bare overlap missed)
 *   unknown      23  (sessions with no actuals in Pandora — incl. the
 *                     Friday-night straggler whose session isn't in
 *                     Saturday's list; at runtime these fall to the
 *                     scan-anchor rung — replay has no assignedAt on
 *                     match records, so they stay unknown)
 *
 * (94 + the straggler = the 95 wrong deliveries reported for 8/9.)
 *
 * Plus the redirect proof: the three REAL heat-29 videos that were stolen
 * by stale h23/h26 slots must be implausible against the slot that took
 * them and plausible against their true owner's heat (blue h29).
 *
 * Run from apps/web:  npx tsx scripts/video-plausibility-replay.mts [YYYY-MM-DD]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import Redis from "ioredis";
import type { HeatActuals } from "../lib/video-plausibility";
/* eslint-disable @typescript-eslint/no-explicit-any */
// tsx false-errors on static value-imports of repo modules ("does not
// provide an export named …") — dynamic import works. Types are fine.
const { estimateCaptureWindow, plausibilityVerdict } = await import("../lib/video-plausibility");

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 3 });
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const ET = "America/New_York";
const DAY = process.argv[2] || "2026-08-09";

function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/([:[,]\s*)(\d{15,})(\s*[,}\]])/g, '$1"$2"$3'));
}
const etDay = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: ET }) : "?";

async function main() {
  // ── heat actuals by sessionId, straight from Pandora ──
  const bySession = new Map<string, HeatActuals>();
  const qs = `startDate=${encodeURIComponent(`${DAY}T00:00:00`)}&endDate=${encodeURIComponent(`${DAY}T23:59:59`)}`;
  for (const track of ["Red Track", "Blue Track"]) {
    const res = await fetch(
      `${PANDORA}/bmi/sessions/${LOC}?${qs}&resourceName=${encodeURIComponent(track)}`,
      { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Pandora ${res.status} for ${track}`);
    for (const s of parseRawIds(await res.text())?.data ?? []) {
      const actuals: HeatActuals = {};
      const aStart = s.actualStart ? new Date(s.actualStart).getTime() : NaN;
      const aEnd = s.actualEnd ? new Date(s.actualEnd).getTime() : NaN;
      if (Number.isFinite(aStart)) actuals.aStartMs = aStart;
      if (Number.isFinite(aEnd)) actuals.aEndMs = aEnd;
      bySession.set(String(s.sessionId), actuals);
    }
  }
  console.log(`sessions with windows: ${bySession.size}`);

  // ── the day's matched records ──
  const startMs = new Date(`${DAY}T00:00:00-04:00`).getTime();
  const endMs = startMs + 30 * 60 * 60 * 1000;
  const ids = await redis.zrevrangebyscore("video-match:log", endMs, startMs);
  const matched: any[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const raws = await redis.mget(...ids.slice(i, i + 400).map((id) => `video-match:${id}`));
    for (const raw of raws) {
      if (!raw) continue;
      try {
        matched.push(JSON.parse(raw));
      } catch {}
    }
  }
  const corpus = matched.filter(
    (m) => etDay(m.capturedAt) === DAY && m.track && m.heatNumber != null && m.sessionId,
  );
  console.log(`labeled matches on ${DAY}: ${corpus.length}`);

  // ── run the REAL gate against each record's own (labeled) session ──
  const counts = { plausible: 0, implausible: 0, unknown: 0 };
  const flagged: string[] = [];
  const byCode = new Map<string, any>();
  for (const m of corpus) {
    byCode.set(m.videoCode, m);
    const capture = estimateCaptureWindow(m.capturedAt, m.duration);
    const actuals = bySession.get(String(m.sessionId)) ?? null;
    // Match records don't carry the assignment's assignedAt, so rung 3
    // is unreachable in replay — pass NaN, which the verdict treats as
    // "refuse to guess" → unknown. At runtime those fall to scan-anchor.
    const r = plausibilityVerdict(
      capture,
      actuals && (actuals.aStartMs != null || actuals.aEndMs != null) ? actuals : null,
      NaN,
    );
    counts[r.verdict]++;
    if (r.verdict === "implausible")
      flagged.push(
        `${m.capturedAt} ${m.firstName} ${m.lastName} [${m.track} h${m.heatNumber}] code=${m.videoCode} sms=${m.notifySmsOk ?? "-"}`,
      );
  }
  console.log(`\nverdicts:`, counts);

  // ── named regression cases ──
  const expectVerdict = (code: string, want: string, note: string) => {
    const m = byCode.get(code);
    if (!m) return console.log(`  ?? ${code} not in corpus (${note})`);
    const r = plausibilityVerdict(
      estimateCaptureWindow(m.capturedAt, m.duration),
      bySession.get(String(m.sessionId)) ?? null,
      NaN,
    );
    const ok = r.verdict === want;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${code} → ${r.verdict} (want ${want}) — ${note}`);
    return ok;
  };
  console.log(`\n── named cases ──`);
  expectVerdict("MKE3MBJ6FX", "plausible", "Dickinson's true h29 video");
  expectVerdict("NUZCNPUC9H", "implausible", "h31 footage on McAdams' h29 slot");
  expectVerdict("C9FUWDTF9F", "implausible", "h31 footage on Becket's h29 slot");
  expectVerdict("R9E3SM7SCR", "implausible", "junior h33/34 footage on Lisa Jones' h29 slot");
  expectVerdict("5KNX6S47UF", "implausible", "EDGE-CLIP: red-h16 footage on Sharp's h17 slot");

  // ── redirect proof: stolen real-h29 videos fit blue h29 (sid 56481508) ──
  console.log(`\n── redirect proof (stolen h29 videos vs their TRUE heat) ──`);
  const h29 = bySession.get("56481508") ?? null;
  for (const [code, owner] of [
    ["83KVCWFQ5K", "Adrianna McAdams"],
    ["VCQCGNY2R3", "Brandon Lowe"],
    ["Q8QMD8EHKB", "Reagan Fielder"],
  ] as const) {
    const m = byCode.get(code);
    if (!m) {
      console.log(`  ?? ${code} not in corpus`);
      continue;
    }
    const vsSlot = plausibilityVerdict(
      estimateCaptureWindow(m.capturedAt, m.duration),
      bySession.get(String(m.sessionId)) ?? null,
      NaN,
    ).verdict;
    const vsTruth = plausibilityVerdict(
      estimateCaptureWindow(m.capturedAt, m.duration),
      h29,
      NaN,
    ).verdict;
    const ok = vsSlot === "implausible" && vsTruth === "plausible";
    console.log(
      `  ${ok ? "PASS" : "FAIL"} ${code}: vs stolen slot [${m.track} h${m.heatNumber}] → ${vsSlot}; vs blue h29 (${owner}'s heat) → ${vsTruth}`,
    );
  }

  console.log(`\n── all implausible (${flagged.length}) ──`);
  for (const f of flagged) console.log("  " + f);

  await redis.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
