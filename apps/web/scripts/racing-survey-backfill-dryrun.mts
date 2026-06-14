/**
 * READ-ONLY dry run: how many racing surveys would the 7-day backfill send?
 *
 * Usage (from apps/web): npx tsx scripts/racing-survey-backfill-dryrun.mts [windowMinutes]
 *
 * Mirrors the racing-survey-sweep candidate filter (force mode: no 15-min
 * floor) over the past N minutes (default 10080 = 7 days). Counts only —
 * sends nothing, writes nothing. Distinct racers ≈ the upper bound on actual
 * sends, since the 30-day per-customer cap collapses multiple races per
 * person to one survey.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const windowMin = Number(process.argv[2] ?? "10080");
const windowMs = windowMin * 60 * 1000;

const { listMatchesInRange } = await import("@/lib/video-match");
const { getGuestSurveyByOriginRef } = await import("@/lib/guest-survey-db");

const now = Date.now();
const matches = await listMatchesInRange({ startMs: now - windowMs, endMs: now, limit: 5000 });

let notNotified = 0,
  tooOld = 0,
  blocked = 0,
  minor = 0,
  noPhone = 0,
  candidateVisits = 0,
  dedupedMultiVisit = 0,
  alreadySurveyedRacers = 0;
const seenPhones = new Set<string>();

for (const m of matches) {
  const ts = m.notifySmsSentAt || m.notifyEmailSentAt;
  if (!ts) {
    notNotified++;
    continue;
  }
  const at = new Date(ts).getTime();
  if (!Number.isFinite(at) || now - at > windowMs) {
    tooOld++;
    continue;
  }
  if (m.blocked) {
    blocked++;
    continue;
  }
  if (m.guardian || m.viaGuardian === true) {
    minor++;
    continue;
  }
  const phone = m.mobilePhone || m.phone || m.homePhone;
  if (!phone) {
    noPhone++;
    continue;
  }
  candidateVisits++;
  // In-run per-racer dedup (mirrors the cron): one attempt per phone.
  if (seenPhones.has(phone)) {
    dedupedMultiVisit++;
    continue;
  }
  seenPhones.add(phone);
  // Idempotency probe (DB read only) on this racer's most-recent video.
  const existing = await getGuestSurveyByOriginRef({ origin: "racing", originRef: m.videoCode });
  if (existing) alreadySurveyedRacers++;
}

const distinctRacers = seenPhones.size;
console.log(`\n=== Racing survey backfill DRY RUN (window = ${windowMin} min / ${(windowMin / 1440).toFixed(1)} days) ===`);
console.log(`scanned matches........... ${matches.length}`);
console.log(`candidate visits.......... ${candidateVisits}   (passed age / not-minor / not-blocked / has-phone)`);
console.log(`  -> multi-visit deduped.. ${dedupedMultiVisit}   (same racer, extra visits — collapsed to one)`);
console.log(`DISTINCT RACERS (max sent) ${distinctRacers}   <- at most this many texts; the 30-day cap can only LOWER it`);
console.log(`  of those, already sent.. ${alreadySurveyedRacers}   (origin_ref idempotency — will be skipped)`);
console.log(`skipped: minor............ ${minor}`);
console.log(`skipped: no phone......... ${noPhone}`);
console.log(`skipped: blocked.......... ${blocked}`);
console.log(`skipped: not notified..... ${notNotified}`);
console.log(`skipped: outside window... ${tooOld}`);
console.log(`\nAnti-spam: in-run dedup (1 per racer) + 30-day per-customer cap + origin_ref idempotency.`);
console.log(`A racer with multiple visits this week gets exactly ONE survey.`);
process.exit(0);
