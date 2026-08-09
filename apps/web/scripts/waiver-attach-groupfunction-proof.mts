/**
 * LIVE PROOF of the group-function waiver-attach fix — NET ZERO.
 *
 * Settles the two things the fix cannot claim without a write:
 *
 *   P1  Does registerProjectPerson, given the order id `resolveAttachOrderId`
 *       returns for a GROUP FUNCTION, actually put the person on the project?
 *       (A 200 proves nothing on this endpoint — verified by re-reading
 *       projectPersons, per tasks/lessons.md "removeItem 200 ≠ success".)
 *
 *   P2  Does a SECOND POST for the same person create a DUPLICATE row?
 *       kiosk-waiver-attach-probe.mts step 4 was written to answer this and its
 *       result was never recorded. The backfill's safety depends on the answer.
 *
 * Also asserts NO SIDE EFFECTS: project state, product count and balance must be
 * byte-identical afterwards.
 *
 * Uses person 63000000002660482 ("tester headpinz") — never a real guest — and
 * REFUSES to run if that person is already on the project, so the cleanup only
 * ever removes rows this probe created. Ends by removing every row it added and
 * re-reading to confirm the project is back to its original row set.
 *
 * READ-ONLY without APPLY=1.
 *
 * Run from apps/web:
 *   PROJECT_ID=55302082 npx tsx scripts/waiver-attach-groupfunction-proof.mts
 *   PROJECT_ID=55302082 APPLY=1 npx tsx scripts/waiver-attach-groupfunction-proof.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */

const APPLY = process.env.APPLY === "1";
const PROJECT_ID = process.env.PROJECT_ID || "55302082"; // H3175 Blue Diamond Plumbing, Aug 15
const CLIENT_KEY = process.env.CLIENT_KEY || "headpinzftmyers";
const TEST_PERSON = process.env.PERSON_ID || "63000000002660482"; // "tester headpinz"

const { fetchProjectRawIds, removeProjectPersonRow } = await import("@/lib/bmi-office-actions");
const { resolveAttachOrderId } = await import("~/features/kiosk/waiver/attach-order-id");
const { registerProjectPersonServer } = await import("~/features/kiosk/waiver/bmi-attach");

interface Snapshot {
  rows: Array<{ id: string; personId: string }>;
  stateId: string;
  products: number;
  balance: string;
  name: string;
  number: string;
}
async function snapshot(): Promise<Snapshot> {
  const p = await fetchProjectRawIds(CLIENT_KEY, PROJECT_ID);
  if (!p) throw new Error(`project ${PROJECT_ID} unreadable`);
  return {
    rows: ((p.projectPersons ?? []) as any[]).map((r) => ({
      id: String(r.id),
      personId: String(r.personId),
    })),
    stateId: String(p.stateId),
    products: ((p.products ?? []) as any[]).length,
    balance: String(p.balance),
    name: String(p.name ?? ""),
    number: String(p.number ?? ""),
  };
}

const before = await snapshot();
console.log(
  `── ${before.number} "${before.name}" · project ${PROJECT_ID} @ ${CLIENT_KEY} · ${APPLY ? "APPLY" : "DRY RUN"} ──`,
);
console.log(
  `  baseline: projectPersons=${before.rows.length} state=${before.stateId} ` +
    `products=${before.products} balance=${before.balance}`,
);

// ── The fix under test: which order id, and via which rail? ────────────────
const resolved = await resolveAttachOrderId({ clientKey: CLIENT_KEY, projectId: PROJECT_ID });
console.log(`\n  resolveAttachOrderId → ${resolved ? `${resolved.orderId} (${resolved.source})` : "NULL"}`);
if (!resolved) {
  console.error("  FAIL: no order id resolved — the fix cannot attach this project.");
  process.exit(1);
}
const { billIdFromOfficeProjectId } = await import("@/lib/bmi-office-actions");
const arithmetic = billIdFromOfficeProjectId(PROJECT_ID);
console.log(`  (the OLD code would have sent ${arithmetic} — ${resolved.orderId === arithmetic ? "same" : "WRONG, and this is the bug"})`);

if (!APPLY) {
  console.log("\n  DRY RUN — nothing POSTed. Re-run with APPLY=1 to prove the attach end to end.");
  process.exit(0);
}

if (before.rows.some((r) => r.personId === TEST_PERSON)) {
  console.error(
    `  REFUSING: test person ${TEST_PERSON} is already on this project — cleanup would remove a row this probe did not create.`,
  );
  process.exit(1);
}

// ── P1: attach, then VERIFY by re-reading ─────────────────────────────────
console.log(`\n══ P1: attach test person ${TEST_PERSON} ══`);
const first = await registerProjectPersonServer({
  clientKey: CLIENT_KEY,
  orderId: resolved.orderId,
  personId: TEST_PERSON,
  firstName: "Probe",
  lastName: "Test",
});
console.log(`  POST #1 → ok=${first.ok} http=${first.status} body=${first.body.slice(0, 200)}`);
const afterFirst = await snapshot();
const added = afterFirst.rows.filter((r) => r.personId === TEST_PERSON);
console.log(`  projectPersons ${before.rows.length} → ${afterFirst.rows.length}; rows for the test person: ${added.length}`);
const p1Pass = added.length === 1;
console.log(`  P1 ${p1Pass ? "PASS — the person is genuinely on the project" : "FAIL — 200 without a row, or no row at all"}`);

console.log(
  `  side effects: state ${before.stateId}→${afterFirst.stateId} · products ${before.products}→${afterFirst.products} · balance ${before.balance}→${afterFirst.balance}`,
);
const clean =
  before.stateId === afterFirst.stateId &&
  before.products === afterFirst.products &&
  before.balance === afterFirst.balance;
console.log(`  ${clean ? "NO side effects" : "SIDE EFFECTS DETECTED — investigate before any bulk run"}`);

// ── P2: idempotency ───────────────────────────────────────────────────────
console.log(`\n══ P2: second POST for the same person (idempotency) ══`);
const second = await registerProjectPersonServer({
  clientKey: CLIENT_KEY,
  orderId: resolved.orderId,
  personId: TEST_PERSON,
  firstName: "Probe",
  lastName: "Test",
});
console.log(`  POST #2 → ok=${second.ok} http=${second.status} body=${second.body.slice(0, 200)}`);
const afterSecond = await snapshot();
const dupes = afterSecond.rows.filter((r) => r.personId === TEST_PERSON);
console.log(`  rows for the test person now: ${dupes.length}`);
const idempotent = dupes.length === 1;
console.log(
  `  P2 ${idempotent ? "IDEMPOTENT — a re-POST does NOT duplicate" : `DUPLICATES — ${dupes.length} rows; every sweep MUST reconcile against BMI first`}`,
);

// ── Cleanup: remove every row this probe added, verify net zero ───────────
console.log(`\n══ CLEANUP ══`);
for (let i = 0; i < dupes.length; i++) {
  const res = await removeProjectPersonRow({
    clientKey: CLIENT_KEY,
    projectId: PROJECT_ID,
    personId: TEST_PERSON,
  });
  console.log(`  remove #${i + 1} → ${JSON.stringify(res)}`);
}
const after = await snapshot();
const stillThere = after.rows.filter((r) => r.personId === TEST_PERSON).length;
const sameSet =
  after.rows.length === before.rows.length &&
  before.rows.every((b) => after.rows.some((a) => a.id === b.id && a.personId === b.personId));
console.log(
  `  final: projectPersons=${after.rows.length} (was ${before.rows.length}) testPersonRows=${stillThere}`,
);
console.log(`  ${stillThere === 0 && sameSet ? "NET ZERO — project restored exactly" : "NOT CLEAN — MANUAL REVIEW REQUIRED"}`);

console.log(
  `\n══ VERDICT ══\n  P1 attach: ${p1Pass ? "PASS" : "FAIL"}\n  P2 re-POST: ${idempotent ? "idempotent" : "DUPLICATES"}\n  side effects: ${clean ? "none" : "PRESENT"}\n  cleanup: ${stillThere === 0 && sameSet ? "net zero" : "DIRTY"}`,
);
process.exit(p1Pass && stillThere === 0 && sameSet ? 0 : 1);
