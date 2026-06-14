/**
 * Remediate existing single-order combo bookings into the two-order split
 * (FastTrax racing + HeadPinz bowling), for UNTENDERED open orders only
 * (charged orders are left for finance — owner decision 2026-06-13).
 *
 * Allocation policy (owner-confirmed 2026-06-13):
 *   - FastTrax FM racing order = EXACT racing revenue: Starter $17 +
 *     Intermediate $17 + POV $5 + License $4.99 = $43.99/person, +6.5% tax.
 *   - HeadPinz FM bowling order = the BALANCER: VIP Bowling + Shoes + the
 *     $2.99 Booking Fee, minus a discount sized so the two new orders sum
 *     to ≤ the shared gift-card balance, to the cent (HeadPinz absorbs any
 *     promo discount + the unavoidable ≤1¢ tax-grid remainder).
 *
 * Why ≤ and not strictly =: tax rounds once on the original single order but
 * twice when split, and not every tax-incl total is reachable on the 6.5%
 * grid. We target the largest reachable HeadPinz total ≤ remainder, so the
 * two orders NEVER sum over the gift card (settlement-safe); any ≤2¢ leftover
 * stays on the card, harmless.
 *
 * Per order: create FT order, create HP order (balancer), assert
 * FT_net + HP_net ≤ GC and the gap ≤ 2¢, repoint the two Neon rows to the new
 * orders (shared gift card unchanged), then best-effort CANCEL the old order.
 *
 * DRY RUN by default. Live writes ONLY with `--live`. Idempotent via
 * remediate-${oldId}-{ft,hp,cancel} keys; re-running --live is safe.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const LIVE = process.argv.includes("--live");
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const SQB = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();

const FASTTRAX_FM = "LAB52GY480CJF";
const HEADPINZ_FM = "TXBSQN0FEKQ11";
const TAX = "UBPQTR3W6ZKVRYFC7DXN2SJN"; // Lee County 6.5%
const TAX_RATE = 0.065;
const SQ = {
  UQ: "X4RZPTPJEJ45OG3S3HMDMCHZ",
  POV: "6BJ7HF2VGITYIA3FRS4RK2AV",
  LICENSE: "7GUST7MZ25TOBOB4UXPDYPV4",
  VIP_BOWLING: "R66TY2VTICYUH4NM3F4UQVLF",
  SHOE: "BVJ2ZSW6N4FPSPSPSB4IN7LA",
  BOOKING_FEE: "7VKAFU3HDPRSKY7ZB6CKXTRW",
};

const ORDERS = [
  "ta8ExW2mU4spvqKtBcdDlkkAiQ6YY",
  "t4TWwoDi4eGylTMu9E44he4XNAbZY",
  "bhooMRGfEhqtJi9oPZsrb4sQVbGZY",
  "vRrKnIKBrUamE1dvZTPWib954SIZY",
];

function isWeekend(ymd: string): boolean {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() : 0;
  return day === 0 || day === 5 || day === 6;
}
// Square order-scope tax: round-HALF-TO-EVEN (banker's) on the (post-discount) subtotal.
function bankersRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1; // exact .5 → nearest even (matches Square)
}
const taxIncl = (subtotalCents: number) => subtotalCents + bankersRound(subtotalCents * TAX_RATE);
// Largest tax-incl total ≤ target reachable by some subtotal in [0, naturalSubtotal].
function balancerSubtotal(target: number, naturalSubtotal: number): number {
  let best = 0;
  for (let s = 0; s <= naturalSubtotal; s++) {
    if (taxIncl(s) <= target) best = s;
    else break;
  }
  return best;
}
const li = (catalog: string, name: string, qty: number, cents: number) => ({
  catalog_object_id: catalog,
  quantity: String(qty),
  base_price_money: { amount: cents, currency: "USD" },
  name,
});

async function createOrder(
  locId: string,
  items: Array<ReturnType<typeof li>>,
  key: string,
  customerId: string | undefined,
  discountCents: number,
) {
  const order: Record<string, unknown> = {
    location_id: locId,
    ...(customerId ? { customer_id: customerId } : {}),
    line_items: items,
    taxes: [{ uid: "loc-tax", catalog_object_id: TAX, scope: "ORDER" }],
  };
  if (discountCents > 0) {
    order.discounts = [
      { uid: "split-adj", name: "Combo split adjustment", amount_money: { amount: discountCents, currency: "USD" }, scope: "ORDER" },
    ];
  }
  const res = await fetch(`${SQB}/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ idempotency_key: key, order }),
  });
  const d = await res.json();
  if (!res.ok || d.errors) throw new Error(`create order failed: ${JSON.stringify(d.errors ?? d)}`);
  return { id: d.order.id as string, total: (d.order.total_money?.amount ?? 0) as number, net: (d.order.net_amount_due_money?.amount ?? 0) as number };
}

console.log(LIVE ? "=== LIVE REMEDIATION ===\n" : "=== DRY RUN (no writes) — pass --live to execute ===\n");

for (const oldId of ORDERS) {
  const o = (await (await fetch(`${SQB}/orders/${oldId}`, { headers: H })).json()).order as
    | {
        version?: number;
        customer_id?: string;
        tenders?: unknown[];
        total_money?: { amount?: number };
        line_items?: Array<{ name?: string; quantity?: string; catalog_object_id?: string; base_price_money?: { amount?: number } }>;
      }
    | undefined;
  if (!o) {
    console.log(`${oldId}: NOT FOUND — skip`);
    continue;
  }
  if ((o.tenders?.length ?? 0) > 0) {
    console.log(`${oldId}: TENDERED — skip (finance reconcile)`);
    continue;
  }
  const comboLine = (o.line_items ?? []).find(
    (l) => /VIP Experience|Race \+ Bowl/i.test(l.name ?? "") || (l.catalog_object_id === SQ.UQ && [6500, 7500].includes(l.base_price_money?.amount ?? 0)),
  );
  const ppl = Number(comboLine?.quantity ?? 0) || 0;
  if (ppl <= 0) {
    console.log(`${oldId}: could not determine person count — skip`);
    continue;
  }

  const rows = (await q`
    SELECT id, product_kind, booked_at, square_gift_card_id, square_gift_card_gan
    FROM bowling_reservations WHERE square_dayof_order_id = ${oldId}
  `) as Array<Record<string, unknown>>;
  const raceRow = rows.find((r) => r.product_kind === "race");
  const bowlRow = rows.find((r) => r.product_kind === "open" || r.product_kind === "kbf");
  const gcId = (rows[0]?.square_gift_card_id ?? "") as string;
  const gan = (rows[0]?.square_gift_card_gan ?? "") as string;
  const ymd = rows[0]?.booked_at ? new Date(rows[0].booked_at as string).toISOString().slice(0, 10) : "";
  const we = isWeekend(ymd);

  // gift-card balance = the money actually available to settle both orders
  let gcBal = -1;
  if (gcId) gcBal = (await (await fetch(`${SQB}/gift-cards/${gcId}`, { headers: H })).json()).gift_card?.balance_money?.amount ?? -1;
  if (gcBal < 0) {
    console.log(`${oldId}: gift card balance unavailable — skip`);
    continue;
  }

  // FastTrax racing = exact racing revenue
  const ftItems = [
    li(SQ.UQ, "Starter Race", ppl, 1700),
    li(SQ.UQ, "Intermediate Race", ppl, 1700),
    li(SQ.POV, "POV Video", ppl, 500),
    li(SQ.LICENSE, "FastTrax License", ppl, 499),
  ];
  const ftSubtotal = ppl * 4399;
  const ftTotal = taxIncl(ftSubtotal);

  // HeadPinz bowling = balancer: bowling + shoes + booking fee, minus discount
  const hpItems = [
    li(SQ.VIP_BOWLING, "VIP Bowling", ppl, we ? 2601 : 1601),
    li(SQ.SHOE, "Shoes", ppl, 500),
    li(SQ.BOOKING_FEE, "Booking Fee", 1, 299),
  ];
  const hpNatural = ppl * (we ? 2601 : 1601) + ppl * 500 + 299;
  const hpTarget = gcBal - ftTotal;
  const hpSubtotal = balancerSubtotal(hpTarget, hpNatural);
  const hpDiscount = hpNatural - hpSubtotal;
  const hpTotal = taxIncl(hpSubtotal);
  const stranded = gcBal - (ftTotal + hpTotal);

  console.log(`\n${oldId}  ${ppl}p ${we ? "we" : "wd"}  gc=${gan} bal=$${(gcBal / 100).toFixed(2)}`);
  console.log(`  FastTrax $${(ftTotal / 100).toFixed(2)}  +  HeadPinz $${(hpTotal / 100).toFixed(2)} (discount $${(hpDiscount / 100).toFixed(2)})  =  $${((ftTotal + hpTotal) / 100).toFixed(2)}  [stranded $${(stranded / 100).toFixed(2)}]`);
  console.log(`  raceRow #${raceRow?.id ?? "MISSING"} → FastTrax   bowlRow #${bowlRow?.id ?? "MISSING"} → HeadPinz`);

  if (stranded < 0) {
    console.log(`  ‼ would oversubscribe gift card — SKIP (manual review)`);
    continue;
  }
  if (!raceRow || !bowlRow) {
    console.log(`  ‼ missing a Neon row — SKIP (manual review)`);
    continue;
  }
  if (!LIVE) {
    console.log(`  → would create 2 orders, repoint both rows, cancel old order`);
    continue;
  }

  // create both split orders
  const ft = await createOrder(FASTTRAX_FM, ftItems, `remediate-${oldId}-ft`, o.customer_id, 0);
  const hp = await createOrder(HEADPINZ_FM, hpItems, `remediate-${oldId}-hp`, o.customer_id, hpDiscount);
  console.log(`  created FastTrax ${ft.id} ($${(ft.total / 100).toFixed(2)})  +  HeadPinz ${hp.id} ($${(hp.total / 100).toFixed(2)})`);

  // HARD GUARD: real constraint = never oversubscribe the gift card, and the
  // gap must be tiny (≤3¢ tax-grid stranding). A large gap means tax didn't
  // apply or something is wrong — abort and leave everything for manual review.
  const liveGap = gcBal - (ft.net + hp.net);
  if (liveGap < 0 || liveGap > 3) {
    console.log(`  ‼ ABORT: live FT+HP net $${((ft.net + hp.net) / 100).toFixed(2)} vs GC $${(gcBal / 100).toFixed(2)} (gap ${liveGap}¢) — NOT repointing/canceling. Manual review.`);
    continue;
  }

  // repoint Neon rows (shared gift card unchanged)
  await q`UPDATE bowling_reservations SET square_dayof_order_id = ${ft.id} WHERE id = ${raceRow.id}`;
  await q`UPDATE bowling_reservations SET square_dayof_order_id = ${hp.id} WHERE id = ${bowlRow.id}`;
  console.log(`  repointed: raceRow #${raceRow.id}→FastTrax, bowlRow #${bowlRow.id}→HeadPinz`);

  // best-effort cancel old order (no tender, now orphaned → harmless even if it fails)
  try {
    const cRes = await fetch(`${SQB}/orders/${oldId}`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ idempotency_key: `remediate-${oldId}-cancel`, order: { version: o.version, state: "CANCELED" } }),
    });
    console.log(`  old order cancel: ${cRes.ok ? "OK" : `FAILED ${cRes.status} (orphaned, non-fatal)`}`);
  } catch (e) {
    console.log(`  old order cancel error (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
console.log(LIVE ? "\n=== DONE ===" : "\n=== DRY RUN COMPLETE ===");
