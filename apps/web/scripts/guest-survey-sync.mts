/**
 * Sync the prod guest_survey_questions table to the in-code seed.
 * Usage (from apps/web): npx tsx scripts/guest-survey-sync.mts
 *
 * Upserts every (tag, ordinal) in GUEST_SURVEY_QUESTIONS_SEED and deactivates
 * any active row no longer in the seed. No sends. Idempotent.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { syncGuestSurveyQuestions } = await import("@/lib/guest-survey-db");
const res = await syncGuestSurveyQuestions();
console.log(`[guest-survey-sync] upserted=${res.upserted} deactivated=${res.deactivated}`);
process.exit(0);
