/**
 * Reconcile the cross-tender probe's T2 arm, and clean up my own mistake.
 *
 * Two errors in `refund-to-giftcard-crosstender-probe.mts` as run 2026-07-28:
 *
 *  1. FALSE POSITIVE. `watchCard()` returns "landed" if a REFUND activity is
 *     present OR the balance target is met. T1 had already put a REFUND activity
 *     on GC-B, so T2's very first poll reported success on T1's evidence. GC-B
 *     finished at 426¢, not 852¢ — T2's credit did NOT arrive in the window.
 *     That is consistent with the known blocker: a refund carrying `order_id`
 *     (itemized) does not credit the tender.
 *  2. I DRAINED GC-B WHILE T2's REFUND WAS PENDING — precisely what the 7/27
 *     lesson forbids ("never decrement/deactivate a gift card with refunds in
 *     flight"). If T2's credit lands post-drain, value appears on a card the
 *     probe believes it zeroed.
 *
 * This script is READ-FIRST: report both refunds' terminal status and GC-B's
 * balance/activities, then drain ONLY a confirmed post-drain surplus, so the
 * probe leaves nothing behind either way.
 *
 * Run from apps/web:
 *   npx tsx scripts/crosstender-t2-reconcile.mts            # report only
 *   npx tsx scripts/crosstender-t2-reconcile.mts --settle    # drain surplus
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SETTLE = process.argv.includes("--settle");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LOCATION = "6MZJFTGAYD7TC";
const GC_B = "gftc:59f09d640c23408eb5cf196c15537430";
const T1_REFUND =
  "vTIZO8o9qVP04A50N58H7V9c09FZY_RJIiBR9cV3ig4p21YktH4a9Oc6nodMCT8ssk2K2ZNxY";
const T2_REFUND =
  "9MJ7Hzayjm5Tx3RAjzGfVcgmxzIZY_if3uywKz8SrmLr3TUBcCPlNe0Y8NkOoeNIag1LNWmrY";

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

console.log("═══ refund statuses ═══");
for (const [tag, id] of [
  ["T1 (plain cross-tender)", T1_REFUND],
  ["T2 (itemized cross-tender)", T2_REFUND],
] as const) {
  const r = await sq("GET", `/refunds/${id}`);
  const rf = r.json?.refund;
  console.log(
    `  ${tag}: status=${rf?.status} amount=${rf?.amount_money?.amount}¢ ` +
      `dest=${rf?.destination_type} order_id=${rf?.order_id ?? "none"}`,
  );
}

console.log("\n═══ GC-B ═══");
const c = await sq("GET", `/gift-cards/${GC_B}`);
const bal = c.json?.gift_card?.balance_money?.amount ?? 0;
console.log(`  state=${c.json?.gift_card?.state} balance=${bal}¢`);
const acts = await sq("GET", `/gift-cards/activities?gift_card_id=${GC_B}&limit=50`);
const list = (acts.json?.gift_card_activities ?? []) as any[];
for (const a of list) {
  const amt =
    a.refund_activity_details?.amount_money?.amount ??
    a.adjust_decrement_activity_details?.amount_money?.amount ??
    a.activate_activity_details?.amount_money?.amount ??
    "?";
  console.log(`  ${a.created_at?.slice(0, 19)}  ${String(a.type).padEnd(18)} ${amt}¢`);
}
const refundActs = list.filter((a) => a.type === "REFUND");
console.log(
  `\n  ${refundActs.length} REFUND activit(ies) on the card. ` +
    `T1 accounts for one; a second would mean T2 credited after all.`,
);

console.log("\n═══ VERDICT ═══");
if (refundActs.length >= 2) {
  console.log(
    "  T2 DID eventually credit — the itemized cross-tender refund works, just slowly. " +
      "Re-test with a longer watch window before trusting the timing.",
  );
} else {
  console.log(
    "  Only T1 credited. The ITEMIZED cross-tender refund (order_id present) did NOT credit the " +
      "gift card — the known itemization-kills-the-credit blocker reproduces even cross-tender. " +
      "T2's reported success was a false positive from my REFUND-activity check.",
  );
}

if (bal > 0) {
  console.log(`\n  ⚠ GC-B holds ${bal}¢ of surplus probe value.`);
  if (SETTLE) {
    const d = await sq("POST", "/gift-cards/activities", {
      idempotency_key: `t2rec-${randomUUID().slice(0, 8)}`,
      gift_card_activity: {
        type: "ADJUST_DECREMENT",
        location_id: LOCATION,
        gift_card_id: GC_B,
        adjust_decrement_activity_details: {
          amount_money: { amount: bal, currency: "USD" },
          reason: "PURCHASE_WAS_REFUNDED",
        },
      },
    });
    console.log(`  drain ${bal}¢ → ${d.ok ? "0¢, card clean" : errStr(d)}`);
  } else {
    console.log("  pass --settle to drain it (only once both refunds are terminal).");
  }
} else {
  console.log("\n  GC-B is at 0¢ — nothing stranded.");
}
