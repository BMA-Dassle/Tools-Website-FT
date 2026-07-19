// Kiosk group-waiver BMI-attach probe — settles the three assumptions gating
// KIOSK_WAIVER_BMI_ATTACH (see src/features/kiosk/waiver/bmi-attach.ts):
//
//   A1  Does Office personprofile/personsByIds carry any waiver field?
//       (If yes, the roster route can drop its per-person Pandora fan-out.)
//   A2  Does the Pandora person GET accept a 17-digit OFFICE person id?
//       (The roster route assumes yes — importLinked relies on it in prod.)
//   A3  Does public-booking person/registerProjectPerson accept an EXISTING
//       confirmed project's id as orderId? (Proven only on fresh booking
//       bills; /api/bmi verifyPostConfirm documents orderId≠projectId offsets,
//       so this MUST pass against a staff-created TEST reservation before the
//       flag flips.) Also: double-POST to learn idempotency (dupe row or not).
//
// READ-ONLY by default. Steps 1-3 (A1/A2) never write. Step 4 (A3) only runs
// with APPLY=1 and needs a THROWAWAY staff test reservation + a test person.
//
// Run from apps/web:
//   PROJECT_ID=123456 npx tsx scripts/kiosk-waiver-attach-probe.mts                      # A1+A2 dry probe
//   PROJECT_ID=123456 PERSON_ID=98765 APPLY=1 npx tsx scripts/kiosk-waiver-attach-probe.mts   # + A3 attach
//   CLIENT_KEY=headpinznaples …                                                          # other center
//
// Gotchas honored (tasks/lessons.md):
//   - Office project GET carries 17-digit ids → parsed with a raw-id quoting
//     pass (regex string-quote before JSON.parse), NEVER res.json().
//   - registerProjectPerson body raw-injects personId/orderId (bmi-register.ts
//     idiom) — ids never touch Number().
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const APPLY = process.env.APPLY === "1";
const PROJECT_ID = process.env.PROJECT_ID || "";
const PERSON_ID = process.env.PERSON_ID || ""; // test person for APPLY
const CLIENT_KEY = process.env.CLIENT_KEY || "headpinzftmyers";

// ── Office API (project + personsByIds) — daily-events data client idiom ────
const OFFICE_BASE = "https://office-api22.sms-timing.com";
// Same env + baked defaults as the app's Office client (bmi-office.ts).
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const SMS_VERSION = "6251006 202511051229";
const SMS_HEADERS = {
  origin: "https://office.bmileisure.com",
  referer: "https://office.bmileisure.com/",
};

// ── Pandora (waiver source of truth) ────────────────────────────────────────
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const PANDORA_LOC: Record<string, string> = {
  headpinzftmyers: "TXBSQN0FEKQ11",
  headpinznaples: "PPTR5G2N0QXF7",
};

// ── BMI public-booking (the attach endpoint under test) ─────────────────────
const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

if (!PROJECT_ID || !/^\d+$/.test(PROJECT_ID)) {
  console.error("PROJECT_ID=<digits> is required (a staff TEST reservation for APPLY runs).");
  process.exit(1);
}
if (!PANDORA_KEY || !BMI_SUB_KEY) {
  console.error("Missing env (SWAGGER_ADMIN_KEY / BMI_SUBSCRIPTION_KEY) — run from apps/web with .env.local.");
  process.exit(1);
}

/** Quote 17-digit id values so JSON.parse never rounds them (standalone-script
 *  version of @ft/db parseWithRawIds — no app import chain per script idiom). */
function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
}

async function officeToken(): Promise<string> {
  const password = OFFICE_PASS_B64 ? Buffer.from(OFFICE_PASS_B64, "base64").toString() : "";
  const res = await fetch(`${OFFICE_BASE}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
      ...SMS_HEADERS,
    },
    body: `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(password)}`,
  });
  if (!res.ok) throw new Error(`Office auth failed: ${res.status}`);
  return (JSON.parse(await res.text()) as { access_token: string }).access_token;
}

function officeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    clientkey: CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
    ...SMS_HEADERS,
  };
}

async function getProject(token: string): Promise<any> {
  const res = await fetch(`${OFFICE_BASE}/api/${CLIENT_KEY}/project/${PROJECT_ID}`, {
    headers: officeHeaders(token),
  });
  if (!res.ok) throw new Error(`project GET failed: ${res.status} ${await res.text()}`);
  return parseRawIds(await res.text());
}

async function publicBookingToken(): Promise<string> {
  const res = await fetch(`${BMI_API_URL}/auth/${CLIENT_KEY}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`public-booking auth failed: ${res.status}`);
  const data = await res.json();
  return data.AccessToken || data.accessToken;
}

function projectPersonIds(project: any): string[] {
  return ((project.projectPersons || []) as any[])
    .map((pp) => (pp?.personId !== undefined && pp?.personId !== null ? String(pp.personId) : ""))
    .filter(Boolean);
}

async function main() {
  console.log(`── kiosk-waiver attach probe · ${CLIENT_KEY} · project ${PROJECT_ID} · ${APPLY ? "APPLY" : "DRY RUN"} ──\n`);

  const token = await officeToken();

  // Step 1 — baseline project snapshot.
  const before = await getProject(token);
  const beforeIds = projectPersonIds(before);
  console.log(`[1] project baseline: state=${before.stateId} persons=${before.persons} ` +
    `projectPersons=${beforeIds.length} products=${(before.products || []).length} schedules=${(before.schedules || []).length}`);

  // Step 2 — A1: dump personsByIds field names (does it carry waiver info?).
  if (beforeIds.length > 0) {
    const res = await fetch(`${OFFICE_BASE}/api/${CLIENT_KEY}/personprofile/personsByIds`, {
      method: "POST",
      headers: officeHeaders(token),
      body: `[${beforeIds.slice(0, 5).join(",")}]`,
    });
    if (res.ok) {
      const profiles = parseRawIds(await res.text());
      const first = Array.isArray(profiles) ? profiles[0] : profiles;
      const fields = first ? Object.keys(first).sort() : [];
      const waiverish = fields.filter((f) => /waiver/i.test(f));
      console.log(`[2] A1 personsByIds fields (${fields.length}): ${fields.join(", ")}`);
      console.log(`    A1 verdict: waiver fields present = ${waiverish.length > 0 ? `YES (${waiverish.join(", ")})` : "NO — keep the Pandora fan-out"}`);
    } else {
      console.log(`[2] A1 personsByIds failed: ${res.status}`);
    }
  } else {
    console.log("[2] A1 skipped — project has no projectPersons yet (add one via BMI first for the dump).");
  }

  // Step 3 — A2: Pandora person GET with a 17-digit Office id.
  const probePid = PERSON_ID || beforeIds[0];
  if (probePid) {
    const loc = PANDORA_LOC[CLIENT_KEY] || PANDORA_LOC.headpinzftmyers;
    const res = await fetch(`${PANDORA}/bmi/person/${loc}/${probePid}?picture=false&allRelated=false`, {
      headers: { Authorization: `Bearer ${PANDORA_KEY}` },
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[3] A2 Pandora GET person ${probePid}: http=${res.status} success=${data?.success} ` +
      `waiverExpiry=${data?.data?.waiverExpiry ?? "n/a"}`);
    console.log(`    A2 verdict: ${res.ok && data?.success ? "ACCEPTS the id" : "REJECTED — roster validity needs the short-id path"}`);
  } else {
    console.log("[3] A2 skipped — no person id available (pass PERSON_ID=…).");
  }

  // Step 4 — A3: the attach itself (APPLY only, throwaway test reservation).
  if (!APPLY) {
    console.log("\n[4] A3 attach: DRY RUN — not POSTing. Re-run with APPLY=1 PERSON_ID=<test person> against a STAFF TEST reservation.");
    return;
  }
  if (!PERSON_ID || !/^\d+$/.test(PERSON_ID)) {
    console.error("[4] APPLY requires PERSON_ID=<digits> (a TEST person, not a real guest).");
    process.exit(1);
  }
  const pbToken = await publicBookingToken();
  const attachOnce = async (label: string) => {
    const res = await fetch(`${BMI_API_URL}/public-booking/${CLIENT_KEY}/person/registerProjectPerson`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pbToken}`,
        "BMI-Subscription-Key": BMI_SUB_KEY,
        "Content-Type": "application/json",
        "Accept-Language": "en",
      },
      // Raw-id injection — ids never pass through Number()/JSON.stringify.
      body: `{"personId":${PERSON_ID},"orderId":${PROJECT_ID},"firstName":"Probe","lastName":"Test"}`,
    });
    const body = await res.text().catch(() => "");
    console.log(`[4] A3 ${label}: http=${res.status} body=${body.slice(0, 300)}`);
    return res.ok;
  };

  await attachOnce("attach POST #1");
  const mid = await getProject(token);
  const midIds = projectPersonIds(mid);
  console.log(`    after #1: projectPersons=${midIds.length} (was ${beforeIds.length}) ` +
    `state=${mid.stateId} (was ${before.stateId}) products=${(mid.products || []).length} (was ${(before.products || []).length})`);
  console.log(`    A3 verdict: ${midIds.length === beforeIds.length + 1 && String(mid.stateId) === String(before.stateId) ? "ATTACH WORKS, no side effects" : "REVIEW OUTPUT — count/state unexpected"}`);

  await attachOnce("attach POST #2 (idempotency)");
  const after = await getProject(token);
  const afterIds = projectPersonIds(after);
  console.log(`    after #2: projectPersons=${afterIds.length} — ${afterIds.length === midIds.length ? "IDEMPOTENT (no dupe)" : "DUPES on re-POST — join route must stay idempotent via Neon status"}`);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
