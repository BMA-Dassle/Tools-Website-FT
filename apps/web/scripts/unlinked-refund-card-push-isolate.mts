/**
 * The entitlement IS on (2026-07-28: an unlinked EXTERNAL refund was ACCEPTED).
 * So why does the same unlinked refund FAIL when the destination is the owner's
 * card on file? Two things left to pin down:
 *
 *   S1  Settle the EXTERNAL control refund — PENDING is not a result.
 *   S2  Is the failure specific to one CARD RECORD or to the card itself?
 *       The owner's customer has FIVE `ccof:` ids, all VISA …5214. If they all
 *       share a fingerprint they are one underlying card and the answer is
 *       "the card"; retry against a DIFFERENT ccof id to be sure it isn't a
 *       single stale card record.
 *
 * Working hypothesis for the card failure (NOT verified — do not record as
 * fact): a linked refund reverses an existing authorization, but an unlinked
 * refund has no payment to reverse, so it must PUSH funds (an OCT). Push-to-card
 * support is common on debit and spotty on credit, and this card is
 * `card_type: CREDIT`. If that is the cause, the fix is a DEBIT card on file,
 * which needs the owner to add one — not something this script can test.
 *
 * Run from apps/web:
 *   npx tsx scripts/unlinked-refund-card-push-isolate.mts          # dry run
 *   npx tsx scripts/unlinked-refund-card-push-isolate.mts --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LOCATION = "6MZJFTGAYD7TC";
const CUSTOMER_ID = "ABRRYRM2HH2BNFBK2FQ16V2ZDG";
const EXTERNAL_REFUND_ID =
  "J0uFpeUqrsSGAbJTAmcr2e9zdI9YY_9C4GVes4XDZ8mYm8J2cvXvOwfoFJJ0FAWm9W1mVGaUU";
// The ccof already tried and failed twice (7/27, 7/28).
const TRIED_CARD_ID = "ccof:CA4SEEOx1Nlm5O-EYZi193ajg8soAg";
const CENTS = 400;
const REASON = "Refund: Reservation Deposit";
const KEY = `unlp-${randomUUID().slice(0, 8)}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }) =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── S2 recon is read-only, so do the fingerprint comparison either way ──────
const cards = await sq("GET", `/cards?customer_id=${CUSTOMER_ID}`);
const list = (cards.json?.cards ?? []).filter((c: any) => c.enabled);
console.log("═══ cards on file ═══");
const prints = new Set<string>();
for (const c of list) {
  prints.add(c.fingerprint);
  console.log(
    `  ${c.id}  ${c.card_brand} …${c.last_4}  type=${c.card_type}  ` +
      `prepaid=${c.prepaid_type ?? "?"}  bin=${c.bin ?? "?"}  fp=${(c.fingerprint ?? "").slice(-12)}` +
      (c.id === TRIED_CARD_ID ? "  ← already failed" : ""),
  );
}
console.log(
  `\n${list.length} enabled card record(s), ${prints.size} distinct fingerprint(s) → ` +
    (prints.size === 1
      ? "ALL ONE PHYSICAL CARD. A retry against another ccof id tests the card RECORD only."
      : "more than one real card is on file — a retry is a genuine second card."),
);
const alt = list.find((c: any) => c.id !== TRIED_CARD_ID);
const debit = list.find((c: any) => c.card_type === "DEBIT");
console.log(
  debit
    ? `A DEBIT card IS on file (${debit.id}) — that is the better push-to-card target.`
    : "No DEBIT card on file — the push-to-card hypothesis cannot be tested without one.",
);

if (!LIVE) {
  console.log("\n=== DRY RUN (pass --live to execute) ===");
  console.log(`Would: GET refund ${EXTERNAL_REFUND_ID.slice(0, 20)}… until it settles`);
  console.log(
    `Would: one more unlinked ${CENTS}¢ refund to ${debit ? "the DEBIT card" : `alt card ${alt?.id ?? "(none)"}`}`,
  );
  process.exit(0);
}

// ── S1: settle the EXTERNAL control refund ──────────────────────────────────
console.log("\n═══ S1  settle the EXTERNAL control refund ═══");
let extStatus = "";
for (let i = 0; i < 10; i++) {
  const r = await sq("GET", `/refunds/${EXTERNAL_REFUND_ID}`);
  extStatus = r.json?.refund?.status ?? "?";
  console.log(`  +${i * 10}s status=${extStatus} destination_type=${r.json?.refund?.destination_type}`);
  if (extStatus === "COMPLETED" || extStatus === "FAILED" || extStatus === "REJECTED") break;
  await sleep(10_000);
}
console.log(
  extStatus === "COMPLETED"
    ? "  → COMPLETED. Unlinked refunds are DEFINITIVELY enabled on this account."
    : `  → ${extStatus}. If this also FAILS, the EXTERNAL acceptance was only validation-deep ` +
        `and the entitlement verdict must be revisited.`,
);

// ── S2: one more card attempt, best available target ────────────────────────
const target = debit ?? alt;
if (!target) {
  console.log("\n═══ S2  SKIPPED — no second card record to try ═══");
} else {
  console.log(
    `\n═══ S2  unlinked ${CENTS}¢ → ${target.card_brand} …${target.last_4} ` +
      `(${target.card_type}, ${target.id}) ═══`,
  );
  const r = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-card2`,
    unlinked: true,
    destination_id: target.id,
    customer_id: CUSTOMER_ID,
    location_id: LOCATION,
    amount_money: { amount: CENTS, currency: "USD" },
    reason: REASON,
  });
  if (!r.ok) {
    console.log(`  REFUSED at create — ${codes(r)} — ${errStr(r)}`);
  } else {
    const id = r.json.refund.id;
    let st = r.json.refund.status;
    console.log(`  created ${id} status=${st}`);
    for (let i = 0; i < 8 && st !== "COMPLETED" && st !== "FAILED" && st !== "REJECTED"; i++) {
      await sleep(10_000);
      const g = await sq("GET", `/refunds/${id}`);
      st = g.json?.refund?.status ?? "?";
      console.log(`  +${(i + 1) * 10}s status=${st}`);
    }
    console.log(
      st === "COMPLETED"
        ? `  → COMPLETED. ${CENTS}¢ landed on …${target.last_4}. The earlier failures were that ` +
            `card RECORD, not the account.`
        : `  → ${st}. Same failure on a ${prints.size === 1 ? "second record of the same card" : "different card"} ` +
            `⇒ the push itself is what Square refuses.`,
    );
  }
}
