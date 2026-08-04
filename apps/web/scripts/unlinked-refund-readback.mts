/**
 * Ground-truth test for unlinked refunds: let SQUARE'S OWN UI create one, then
 * read back exactly what it built.
 *
 * Ten rounds of API probing could not answer "is this enabled" because the gates
 * are invisible to the Refunds API (subscription tier + per-application
 * authorization). This flips the instrument: the owner performs ONE unlinked
 * refund in the Square POS app, and we diff the account's unlinked refunds to
 * see what Square itself produced — whether it reached COMPLETED, what
 * `destination_type` it used, and what shape we should be sending.
 *
 * Usage, from apps/web:
 *   1. npx tsx scripts/unlinked-refund-readback.mts --snapshot
 *      (run BEFORE the owner touches the POS — records what already exists)
 *   2. owner: Square POS app (retail mode) → Transactions → "Unlinked refund"
 *   3. npx tsx scripts/unlinked-refund-readback.mts --check
 *      (dumps any NEW unlinked refund in full, plus its order + gift-card
 *       activity if it landed on a gift card)
 *
 * Read-only. Writes nothing to Square — only a local snapshot file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const MODE = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--snapshot")
    ? "snapshot"
    : null;
const SNAP =
  "C:/Users/ERICOS~1.COR/AppData/Local/Temp/claude/c--GIT-Tools-Website-FT/" +
  "199cd2ee-4805-44e3-9b27-c4be5810aa35/scratchpad/unlinked-refund-snapshot.json";
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};

if (!MODE) {
  console.log("pass --snapshot (before the POS action) or --check (after it)");
  process.exit(2);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}

/** Every refund on the account with no payment_id / unlinked=true, newest first. */
async function unlinkedRefunds() {
  const out: any[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const q =
      `/refunds?begin_time=${encodeURIComponent("2026-07-01T00:00:00Z")}` +
      `&sort_order=DESC&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await sq(q);
    if (!r.ok) {
      console.log(`refund list failed: HTTP ${r.status} ${JSON.stringify(r.json?.errors)}`);
      break;
    }
    out.push(...(r.json.refunds ?? []).filter((x: any) => x.unlinked === true || !x.payment_id));
    cursor = r.json.cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

const now = await unlinkedRefunds();

if (MODE === "snapshot") {
  mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, JSON.stringify({ ids: now.map((r) => r.id) }, null, 2));
  console.log(`snapshot saved: ${now.length} existing unlinked refund(s) recorded.`);
  console.log(`  ${SNAP}`);
  console.log("\nNow, on the Square POS app (retail mode) as an owner/admin:");
  console.log("  Transactions → Unlinked refund → amount + item description → Next");
  console.log("  → choose the refund method (gift card / card) → reason → Refund");
  console.log("\nIf 'Unlinked refund' is NOT in that menu, stop — that is the answer:");
  console.log("  · check the plan (Square Plus / Premium / Retail Plus or Premium), and");
  console.log("  · Dashboard → Team → permissions → 'issue unlinked refunds'");
  console.log("\nThen re-run with --check.");
  process.exit(0);
}

// ── check ───────────────────────────────────────────────────────────────────
if (!existsSync(SNAP)) {
  console.log("no snapshot found — run --snapshot first (ideally before the POS action).");
  process.exit(2);
}
const before: string[] = JSON.parse(readFileSync(SNAP, "utf8")).ids ?? [];
const fresh = now.filter((r) => !before.includes(r.id));

console.log(`${before.length} unlinked refund(s) before, ${now.length} now → ${fresh.length} NEW`);

if (!fresh.length) {
  console.log(
    "\nNothing new. Either the POS action was not completed, or the POS could not offer it.\n" +
      "If 'Unlinked refund' was missing from the Transactions menu, the blocker is the\n" +
      "SUBSCRIPTION TIER or the 'issue unlinked refunds' team permission — not our code, and\n" +
      "no API request shape can work until that changes.",
  );
  process.exit(0);
}

for (const r of fresh) {
  console.log(`\n═══ NEW unlinked refund ${r.id} ═══`);
  console.log(JSON.stringify(r, null, 2));

  if (r.order_id) {
    const o = await sq(`/orders/${r.order_id}`);
    const ord = o.json?.order;
    console.log(
      `\n  its order ${r.order_id}: state=${ord?.state} returns=${(ord?.returns ?? []).length} ` +
        `return_amounts.total=${ord?.return_amounts?.total_money?.amount ?? "-"}¢`,
    );
    for (const ret of ord?.returns ?? []) {
      for (const li of ret.return_line_items ?? []) {
        console.log(
          `    return line "${li.name ?? "(unnamed)"}" item_type=${li.item_type} ` +
            `${li.total_money?.amount}¢ catalog=${li.catalog_object_id ?? "none"}`,
        );
      }
    }
  }

  const gan = r.destination_details?.card_details?.card?.last_4;
  console.log(
    `\n  VERDICT: status=${r.status} destination_type=${r.destination_type} ` +
      `${gan ? `…${gan}` : ""}`,
  );
  console.log(
    r.status === "COMPLETED"
      ? "  Square's own UI CAN complete an unlinked refund ⇒ the capability is LIVE on this\n" +
          "  account and the only gap is OUR APPLICATION's authorization. Take this refund id to\n" +
          "  the rep and ask for the app to be authorized for unlinked refunds via the Refunds API."
      : `  Square's own UI produced status=${r.status} — the same failure our API calls get, so the\n` +
          "  block is account-level, not application-level. That is a much stronger case for the rep.",
  );
}
