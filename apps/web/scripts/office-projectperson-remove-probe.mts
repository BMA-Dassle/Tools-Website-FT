// Office projectPerson REMOVE probe — proves the roster-removal API before the
// organizer link's Remove button is wired to it (owner HAR 2026-07-31,
// Downloads/Delete.har: the Office UI's own remove is
//   DELETE /api/{clientKey}/projectPerson?id={projectPersonRowId}
// keyed on the ROW id from project.projectPersons[], NOT the personId).
//
// Per tasks/lessons.md ("removeItem 200 ≠ success", "demand per-item results"):
// a 200 from BMI proves nothing — every step here re-reads the project and
// asserts the row set actually changed.
//
// READ-ONLY by default (lists projectPersons rows). APPLY=1 runs the full
// add → verify → delete → verify cycle and ends NET-ZERO: it refuses to run if
// the person is already on the project, so the delete only ever removes the
// row this probe just added.
//
// Run from apps/web:
//   PROJECT_ID=55762353 npx tsx scripts/office-projectperson-remove-probe.mts
//   PROJECT_ID=55762353 PERSON_ID=63000000002921291 APPLY=1 npx tsx scripts/office-projectperson-remove-probe.mts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const APPLY = process.env.APPLY === "1";
const PROJECT_ID = process.env.PROJECT_ID || "";
const PERSON_ID = process.env.PERSON_ID || "";
const CLIENT_KEY = process.env.CLIENT_KEY || "headpinzftmyers";

const OFFICE_BASE = "https://office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const SMS_VERSION = "6251006 202511051229";
const SMS_HEADERS = {
  origin: "https://office.bmileisure.com",
  referer: "https://office.bmileisure.com/",
};

if (!PROJECT_ID || !/^\d+$/.test(PROJECT_ID)) {
  console.error("PROJECT_ID=<digits> required.");
  process.exit(1);
}
if (APPLY && (!PERSON_ID || !/^\d+$/.test(PERSON_ID))) {
  console.error("APPLY=1 needs PERSON_ID=<digits> (a test person NOT already on the project).");
  process.exit(1);
}

/** Quote long id values so JSON.parse never rounds them (script-local
 *  parseWithRawIds — no app import chain per script idiom). */
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

interface PpRow {
  id: string;
  personId: string;
}

async function projectPersons(token: string): Promise<PpRow[]> {
  const res = await fetch(`${OFFICE_BASE}/api/${CLIENT_KEY}/project/${PROJECT_ID}`, {
    headers: officeHeaders(token),
  });
  if (!res.ok) throw new Error(`project GET failed: ${res.status} ${await res.text()}`);
  const project = parseRawIds(await res.text());
  return ((project.projectPersons ?? []) as any[]).map((r) => ({
    id: String(r.id),
    personId: String(r.personId),
  }));
}

async function main() {
  const token = await officeToken();

  const before = await projectPersons(token);
  console.log(`project ${PROJECT_ID} @ ${CLIENT_KEY}: ${before.length} projectPersons`);
  for (const r of before) console.log(`  row ${r.id} -> person ${r.personId}`);
  if (!APPLY) {
    console.log("\nDry run only. APPLY=1 PERSON_ID=<id> runs add -> verify -> delete -> verify.");
    return;
  }

  if (before.some((r) => r.personId === PERSON_ID)) {
    console.error(
      `REFUSING: person ${PERSON_ID} is already on the project — this probe only deletes the row it adds.`,
    );
    process.exit(1);
  }

  // 1. ADD (the Office UI's own call, verbatim from the HAR — both ids are
  //    JSON strings on the wire, so no precision risk).
  const addRes = await fetch(`${OFFICE_BASE}/api/${CLIENT_KEY}/projectPerson`, {
    method: "POST",
    headers: officeHeaders(token),
    body: `{"projectId":"${PROJECT_ID}","personId":"${PERSON_ID}"}`,
  });
  console.log(`\nPOST projectPerson -> ${addRes.status} ${(await addRes.text()).slice(0, 200)}`);

  // 2. VERIFY the row exists (a 200 alone proves nothing).
  const afterAdd = await projectPersons(token);
  const row = afterAdd.find((r) => r.personId === PERSON_ID);
  if (!row) {
    console.error("FAIL: POST returned but the person is NOT on the project — 200 ≠ success.");
    process.exit(1);
  }
  console.log(`VERIFIED add: row ${row.id} -> person ${row.personId}`);

  // 3. DELETE by ROW id.
  const delRes = await fetch(
    `${OFFICE_BASE}/api/${CLIENT_KEY}/projectPerson?id=${encodeURIComponent(row.id)}`,
    { method: "DELETE", headers: officeHeaders(token) },
  );
  console.log(`DELETE projectPerson?id=${row.id} -> ${delRes.status} ${(await delRes.text()).slice(0, 200)}`);

  // 4. VERIFY the row is gone AND nothing else changed.
  const afterDel = await projectPersons(token);
  const stillThere = afterDel.some((r) => r.personId === PERSON_ID);
  const collateral =
    before.length !== afterDel.length ||
    before.some((b) => !afterDel.some((a) => a.id === b.id && a.personId === b.personId));
  if (stillThere) {
    console.error("FAIL: DELETE returned but the row is STILL on the project.");
    process.exit(1);
  }
  if (collateral) {
    console.error("FAIL: the row set differs from the original — collateral change, investigate.");
    console.error("before:", JSON.stringify(before), "after:", JSON.stringify(afterDel));
    process.exit(1);
  }
  console.log("\nPASS: add verified, delete verified, project back to its original row set.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
