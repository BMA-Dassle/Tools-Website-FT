/**
 * Upload -> verify -> submit chargeback evidence to Square.
 *
 * THREE PHASES, in order:
 *   1. upload  — POST evidence-files / evidence-text. A reused idempotency key
 *                returns 400 IDEMPOTENCY_KEY_REUSED, which means "already
 *                uploaded", NOT a failure — we treat it as present.
 *   2. verify  — GET /disputes/{id}/evidence and confirm every expected item
 *                landed. If anything is missing we STOP. No submit.
 *   3. submit  — POST /disputes/{id}/submit-evidence. ONE call. IRREVERSIBLE.
 *                Only runs with the explicit --submit flag.
 *
 * Usage:
 *   npx tsx scripts/dispute-evidence-submit.mts            # upload + verify only
 *   npx tsx scripts/dispute-evidence-submit.mts --submit   # ...then submit
 */
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const TOKEN = env.match(/^SQUARE_ACCESS_TOKEN=(.+)$/m)![1].trim().replace(/^"|"$/g, "");
const BASE = "https://connect.squareup.com/v2";
const AUTH = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2025-01-23" };
const DO_SUBMIT = process.argv.includes("--submit");

type FileItem = { kind: "file"; type: string; path: string; key: string };
type TextItem = { kind: "text"; type: string; text: string; key: string };
type Item = FileItem | TextItem;

const D1 = "7LgzFaOjCUKwtb3RommPB";
const D2 = "mH6xiOSaVMqmxKetS9ZmUD";
const D3 = "rZLz94tH8Tr0O6iQIJzb4";

/** --only <disputeId> restricts the run to one dispute (avoids re-touching
 *  already-submitted ones, which are no longer EVIDENCE_REQUIRED). */
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const REBUTTAL_1 = "C:\\Work\\dispute-7Lgz-ciotola-duplicate-rebuttal.pdf";
const WAIVER_1 = "C:\\Work\\waiver salvatore.pdf";
const REBUTTAL_2 = "C:\\Work\\dispute-mH6x-forbes-noknowledge-rebuttal.pdf";
const CONTRACT_2 = "C:\\Work\\contract.pdf";

// evidence_text is capped at 500 characters by Square.
const TEXT_1 =
  "The card ending 1140 was charged exactly once. We searched 122,277 card payments across all 16 of our " +
  "locations from Jun 1 - Aug 2 2026: it appears ONE time ($240.59, Jul 24). No second authorization " +
  "exists. The apparent duplicate is our paid deposit converting to stored-value credit, then redeemed " +
  "against that evening's race bill - not a card charge. AVS accepted; billing name Salvatore Ciotola. " +
  "He accepted our payment policy 14 seconds before the charge and signed a waiver barring chargebacks.";

const TEXT_2 =
  "The cardholder personally signed an electronic event contract naming her (ref JTR4X-BUWQJ-OCWKA-GSODZ) " +
  "from an IP in Naples FL on May 1 2026 01:16 UTC, and was charged the exact contracted deposit of " +
  "$212.72 eighty-five seconds later. She then attended the event on May 2, added food and cocktails, and " +
  "settled the $216.34 balance IN PERSON at our front desk on a second card. Collected $429.06 vs $425.43 " +
  "contracted. Dispute filed 89 days after service.";

const REBUTTAL_3 = "C:\\Work\\dispute-rZLz-tarver-noknowledge-rebuttal.pdf";

const TEXT_3 =
  "This charge passed CVV AND AVS verification - the payer held the physical card. The same card " +
  "bought a $250 eGift Card that same evening which is NOT disputed; those funds were redeemed to " +
  "$0.00 in person on three staff-carried terminals at this venue between 9:15 and 11:37 PM on 7/25, " +
  "bracketing the 10:12 PM race this deposit paid for. A sweep of 169,917 payments across all 16 of " +
  "our locations since May 1 finds exactly 2 charges on this card. $0 refunded.";

const FULL_PLAN: Record<string, Item[]> = {
  [D1]: [
    { kind: "file", type: "REBUTTAL_EXPLANATION", path: REBUTTAL_1, key: "7Lgz-rebuttal-v1" },
    // reason=DUPLICATE: this type is FILE-ONLY (text returns 400)
    { kind: "file", type: "DUPLICATE_CHARGE_DOCUMENTATION", path: REBUTTAL_1, key: "7Lgz-dupdoc-v1" },
    { kind: "file", type: "CANCELLATION_OR_REFUND_DOCUMENTATION", path: WAIVER_1, key: "7Lgz-waiver-v1" },
    { kind: "text", type: "GENERIC_EVIDENCE", text: TEXT_1, key: "7Lgz-generic-v1" },
  ],
  [D2]: [
    { kind: "file", type: "REBUTTAL_EXPLANATION", path: REBUTTAL_2, key: "mH6x-rebuttal-v1" },
    { kind: "file", type: "CANCELLATION_OR_REFUND_DOCUMENTATION", path: CONTRACT_2, key: "mH6x-contract-v1" },
    { kind: "file", type: "SERVICE_RECEIVED_DOCUMENTATION", path: REBUTTAL_2, key: "mH6x-service-v1" },
    { kind: "text", type: "GENERIC_EVIDENCE", text: TEXT_2, key: "mH6x-generic-v1" },
  ],
  // No signed contract or waiver exists for this party, so there is no separate
  // exhibit file — the rebuttal PDF carries both the rebuttal and the service proof.
  [D3]: [
    { kind: "file", type: "REBUTTAL_EXPLANATION", path: REBUTTAL_3, key: "rZLz-rebuttal-v1" },
    { kind: "file", type: "SERVICE_RECEIVED_DOCUMENTATION", path: REBUTTAL_3, key: "rZLz-service-v1" },
    { kind: "text", type: "GENERIC_EVIDENCE", text: TEXT_3, key: "rZLz-generic-v1" },
  ],
};

const PLAN: Record<string, Item[]> = ONLY
  ? { [ONLY]: FULL_PLAN[ONLY] ?? [] }
  : FULL_PLAN;
if (ONLY && !FULL_PLAN[ONLY]) throw new Error(`--only ${ONLY}: no plan defined for that dispute`);
if (ONLY) console.log(`Restricted to dispute ${ONLY}\n`);

for (const [label, t] of [["D1", TEXT_1], ["D2", TEXT_2], ["D3", TEXT_3]] as const) {
  if (t.length > 500) throw new Error(`${label} evidence_text is ${t.length} chars (max 500)`);
  console.log(`${label} evidence_text length: ${t.length}/500 OK`);
}

async function uploadFile(disputeId: string, it: FileItem) {
  const buf = readFileSync(it.path);
  const mb = buf.length / 1_048_576;
  if (mb > 5) throw new Error(`${it.path} is ${mb.toFixed(2)} MB (max 5)`);
  const fd = new FormData();
  fd.append(
    "request",
    new Blob(
      [JSON.stringify({ idempotency_key: it.key, evidence_type: it.type, content_type: "application/pdf" })],
      { type: "application/json" },
    ),
  );
  fd.append("file", new Blob([new Uint8Array(buf)], { type: "application/pdf" }), "evidence.pdf");
  // NOTE: no manual Content-Type — fetch must set the multipart boundary.
  const r = await fetch(`${BASE}/disputes/${disputeId}/evidence-files`, {
    method: "POST",
    headers: AUTH,
    body: fd,
  });
  // NOTE: evidence-files returns 201 Created on success, not 200.
  return { status: r.status, ok: r.ok, body: (await r.json()) as any, mb };
}

async function uploadText(disputeId: string, it: TextItem) {
  const r = await fetch(`${BASE}/disputes/${disputeId}/evidence-text`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: it.key, evidence_type: it.type, evidence_text: it.text }),
  });
  return { status: r.status, ok: r.ok, body: (await r.json()) as any };
}

const reused = (b: any) => (b?.errors ?? []).some((e: any) => e.code === "IDEMPOTENCY_KEY_REUSED");

/* ─────────────────── PHASE 1: upload ─────────────────── */
console.log("\n=============== PHASE 1: UPLOAD ===============");
let uploadFailed = false;

for (const [disputeId, items] of Object.entries(PLAN)) {
  console.log(`\n--- dispute ${disputeId}`);
  for (const it of items) {
    const res = it.kind === "file" ? await uploadFile(disputeId, it) : await uploadText(disputeId, it);
    const size = "mb" in res && typeof res.mb === "number" ? ` ${res.mb.toFixed(2)}MB` : "";
    if (res.ok) {
      const id = res.body?.evidence?.id ?? res.body?.evidence?.evidence_id ?? "(no id)";
      console.log(`  OK   ${it.type.padEnd(38)}${size}  -> ${id}`);
    } else if (reused(res.body)) {
      console.log(`  DUP  ${it.type.padEnd(38)}${size}  -> already uploaded (idempotency key reused)`);
    } else {
      uploadFailed = true;
      console.log(`  FAIL ${it.type.padEnd(38)}${size}  -> ${res.status} ${JSON.stringify(res.body?.errors ?? res.body)}`);
    }
  }
}

/* ─────────────────── PHASE 2: verify ─────────────────── */
console.log("\n=============== PHASE 2: VERIFY ===============");
const ready: string[] = [];

for (const [disputeId, items] of Object.entries(PLAN)) {
  const r = await fetch(`${BASE}/disputes/${disputeId}/evidence`, { headers: AUTH });
  const body = (await r.json()) as any;
  const present = ((body.evidence ?? []) as any[]).map((e) => e.evidence_type);
  const want = items.map((i) => i.type);
  const missing = want.filter((t) => !present.includes(t));

  const d = await fetch(`${BASE}/disputes/${disputeId}`, { headers: AUTH });
  const state = ((await d.json()) as any).dispute?.state;

  console.log(`\n--- dispute ${disputeId}  state=${state}`);
  console.log(`  on file (${present.length}): ${present.join(", ") || "(none)"}`);
  if (missing.length) {
    console.log(`  MISSING: ${missing.join(", ")}  -> WILL NOT SUBMIT`);
  } else if (state !== "EVIDENCE_REQUIRED") {
    console.log(`  state is ${state}, not EVIDENCE_REQUIRED -> WILL NOT SUBMIT`);
  } else {
    console.log(`  all ${want.length} expected items present`);
    ready.push(disputeId);
  }
}

/* ─────────────────── PHASE 3: submit ─────────────────── */
console.log("\n=============== PHASE 3: SUBMIT ===============");
if (uploadFailed) {
  console.log("An upload failed. Aborting before submit.");
  process.exit(1);
}
if (!DO_SUBMIT) {
  console.log(`Dry run. ${ready.length} dispute(s) ready. Re-run with --submit to submit.`);
  process.exit(0);
}

for (const disputeId of ready) {
  const r = await fetch(`${BASE}/disputes/${disputeId}/submit-evidence`, { method: "POST", headers: AUTH });
  const body = (await r.json()) as any;
  if (r.ok) {
    console.log(`  SUBMITTED ${disputeId} -> state ${body.dispute?.state}`);
  } else {
    console.log(`  SUBMIT FAILED ${disputeId} -> ${r.status} ${JSON.stringify(body.errors ?? body)}`);
  }
}
