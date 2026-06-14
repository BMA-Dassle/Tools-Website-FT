/**
 * One-off: fire a REAL FastTrax racing survey SMS to a test number from the
 * dev machine (uses prod Neon + Square + Vox via .env.local).
 *
 * Usage (from apps/web): npx tsx scripts/racing-survey-fire-test.mts 2397762044
 *
 * Steps:
 *   1. syncGuestSurveyQuestions() — push the new racing + food_drink seed
 *      into the questions table (idempotent upsert; leaves bowling untouched).
 *   2. Wipe prior guest_surveys + guest_survey marketing_touches for the
 *      phone so the 30-day cap / origin_ref uniqueness don't block the test.
 *   3. recordOptIn + enqueueRacingSurvey → real SMS via Vox.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const rawPhone = process.argv[2] ?? "2397762044";

const { syncGuestSurveyQuestions, deleteGuestSurveysByPhone } = await import(
  "@/lib/guest-survey-db"
);
const { deleteMarketingTouchesByPhone } = await import("@/lib/marketing-db");
const { recordOptIn, normalizePhoneE164 } = await import("~/features/marketing");
const { enqueueRacingSurvey } = await import("~/features/guest-survey");

const phoneE164 = normalizePhoneE164(rawPhone);
console.log(`\n[fire-test] target phone = ${phoneE164}`);

// 1. Sync questions
const sync = await syncGuestSurveyQuestions();
console.log(`[fire-test] sync questions: upserted=${sync.upserted} deactivated=${sync.deactivated}`);

// 2. Clear prior rows for this phone (so the cap can't block the test)
const wipedSurveys = await deleteGuestSurveysByPhone(phoneE164);
const wipedTouches = await deleteMarketingTouchesByPhone({ phoneE164, campaign: "guest_survey" });
console.log(`[fire-test] wiped: surveys=${wipedSurveys} touches=${wipedTouches}`);

// 3. Ensure opt-in + fire
await recordOptIn({ phoneE164, source: "admin" });
const visitDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const videoCode = `admin-test-${phoneE164.replace(/\D/g, "")}-${new Date().toISOString().slice(0, 16)}`;

const outcome = await enqueueRacingSurvey({
  videoCode,
  phone: phoneE164,
  guestName: "Eric Test",
  centerCode: "LAB52GY480CJF",
  visitDate,
  isMinor: false,
});

console.log(`[fire-test] outcome = ${JSON.stringify(outcome, null, 2)}`);
process.exit(outcome.status === "sent" ? 0 : 1);
