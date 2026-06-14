/**
 * Remediate the 3 ALREADY-CHARGED single-order VIP combos into the two-order
 * split (FastTrax racing + HeadPinz bowling), owner-approved 2026-06-13.
 *
 * These differ from the untendered remediation: the gift card was already
 * charged on the single HeadPinz order, so we must:
 *   1) REFUND the gift-card tender on the old order (money returns to the card)
 *   2) create the FastTrax racing order + HeadPinz bowling balancer order
 *   3) RE-CHARGE the gift card against each split order (their events already
 *      passed, so the settlement crons won't do it) and COMPLETE them
 *   4) repoint the Neon rows + fix their totals
 *   5) cancel the old (now refunded) order
 *
 * Net customer impact: zero (same card, same total). Revenue moves to the
 * correct locations. Same balancer math as combo-split-remediate.mts so the two
 * new orders never exceed the refunded amount.
 *
 * Candidates = combos whose two legs still SHARE one day-of order (the already-
 * split ones have separate orders, so they're naturally excluded).
 *
 * DRY RUN by default (also dumps tender ids). Live ONLY with --live. Idempotent
 * via remediate-charged-${oldId}-{refund,ft,hp,ft-pay,hp-pay,cancel} keys.
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
const TAX = "UBPQTR3W6ZKVRYFC7DXN2SJN";
const TAX_RATE = 0.065;
const SQ = {
  UQ: "X4RZPTPJEJ45OG3S3HMDMCHZ",
  POV: "6BJ7HF2VGITYIA3FRS4RK2AV",
  LICENSE: "7GUST7MZ25TOBOB4UXPDYPV4",
  VIP_BOWLING: "R66TY2VTICYUH4NM3F4UQVLF",
  SHOE: "BVJ2ZSW6N4FPSPSPSB4IN7LA",
  BOOKING_FEE: "7VKAFU3HDPRSKY7ZB6CKXTRW",
};

function bankersRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
const taxIncl = (s: number) => s + bankersRound(s * TAX_RATE);
function balancerSubtotal(target: number, natural: number): number {
  let best = 0;
  for (let s = 0; s <= natural; s++) {
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createOrder(locId: string, items: Array<ReturnType<typeof li>>, key: string, customerId: string | undefined, discountCents: number) {
  const order: Record<string, unknown> = {
    location_id: locId,
    ...(customerId ? { customer_id: customerId } : {}),
    line_items: items,
    taxes: [{ uid: "loc-tax", catalog_object_id: TAX, scope: "ORDER" }],
  };
  if (discountCents > 0)
    order.discounts = [{ uid: "split-adj", name: "Combo split adjustment", amount_money: { amount: discountCents, currency: "USD" }, scope: "ORDER" }];
  const res = await fetch(`${SQB}/orders`, { method: "POST", headers: H, body: JSON.stringify({ idempotency_key: key, order }) });
  const d = await res.json();
  if (!res.ok || d.errors) throw new Error(`create order: ${JSON.stringify(d.errors ?? d)}`);
  return { id: d.order.id as string, total: (d.order.total_money?.amount ?? 0) as number };
}
async function chargeGiftCard(orderId: string, locId: string, gcId: string, amount: number, key: string) {
  const res = await fetch(`${SQB}/payments`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ idempotency_key: key, source_id: gcId, amount_money: { amount, currency: "USD" }, order_id: orderId, location_id: locId, autocomplete: true, note: "combo split re-charge" }),
  });
  const d = await res.json();
  if (!res.ok || d.errors) throw new Error(`charge: ${JSON.stringify(d.errors ?? d)}`);
  return d.payment?.id as string;
}

console.log(LIVE ? "=== LIVE (refund + re-split + re-charge) ===\n" : "=== DRY RUN (no writes) — pass --live ===\n");

// Single-order combos = both legs share one day-of order id.
const groups = (await q`
  SELECT square_dayof_order_id AS oid, array_agg(id ORDER BY id) AS ids, count(*) AS n
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL AND square_dayof_order_id IS NOT NULL
  GROUP BY square_dayof_order_id
  HAVING count(*) >= 2
`) as Array<{ oid: string; ids: number[]; n: number }>;

for (const g of groups) {
  const oldId = g.oid;
  const o = (await (await fetch(`${SQB}/orders/${oldId}`, { headers: H })).json()).order as {
    version?: number;
    customer_id?: string;
    total_money?: { amount?: number };
    tenders?: Array<{ id?: string; payment_id?: string; amount_money?: { amount?: number } }>;
    line_items?: Array<{ name?: string; quantity?: string; catalog_object_id?: string; base_price_money?: { amount?: number } }>;
  };
  const comboLine = (o.line_items ?? []).find((l) => /VIP Experience|Race \+ Bowl/i.test(l.name ?? "") || (l.catalog_object_id === SQ.UQ && [6500, 7500].includes(l.base_price_money?.amount ?? 0)));
  const ppl = Number(comboLine?.quantity ?? 0) || 0;
  const tender = (o.tenders ?? [])[0];
  const paymentId = tender?.payment_id ?? tender?.id;
  const tenderAmt = tender?.amount_money?.amount ?? o.total_money?.amount ?? 0;

  const rows = (await q`
    SELECT id, product_kind, booked_at, square_gift_card_id AS gc, square_gift_card_gan AS gan
    FROM bowling_reservations WHERE square_dayof_order_id = ${oldId}
  `) as Array<Record<string, unknown>>;
  const raceRow = rows.find((r) => r.product_kind === "race");
  const bowlRow = rows.find((r) => r.product_kind === "open" || r.product_kind === "kbf");
  const gcId = (rows[0]?.gc ?? "") as string;
  const ymd = rows[0]?.booked_at ? new Date(rows[0].booked_at as string).toISOString().slice(0, 10) : "";
  const dd = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dow = dd ? new Date(Number(dd[1]), Number(dd[2]) - 1, Number(dd[3])).getDay() : 0;
  const we = dow === 0 || dow === 5 || dow === 6;

  const ftSub = ppl * 4399;
  const ftTotal = taxIncl(ftSub);
  const hpNatural = ppl * (we ? 2601 : 1601) + ppl * 500 + 299;
  const hpSub = balancerSubtotal(tenderAmt - ftTotal, hpNatural);
  const hpDisc = hpNatural - hpSub;
  const hpTotal = taxIncl(hpSub);
  const stranded = tenderAmt - (ftTotal + hpTotal);

  console.log(`\n${oldId.slice(0, 10)}  ${ppl}p ${we ? "we" : "wd"}  rows=[${g.ids.join(",")}] gc=${gcId.slice(0, 10)}`);
  console.log(`  tender payment=${paymentId} amount=$${(tenderAmt / 100).toFixed(2)}`);
  console.log(`  → refund $${(tenderAmt / 100).toFixed(2)}, then FastTrax $${(ftTotal / 100).toFixed(2)} + HeadPinz $${(hpTotal / 100).toFixed(2)} (disc $${(hpDisc / 100).toFixed(2)}) = $${((ftTotal + hpTotal) / 100).toFixed(2)} [stranded $${(stranded / 100).toFixed(2)}]`);

  if (ppl <= 0 || !paymentId || stranded < 0 || !raceRow || !bowlRow || !gcId) {
    console.log(`  ‼ SKIP — missing data (ppl/payment/rows/gc) or oversubscribe`);
    continue;
  }
  if (!LIVE) {
    console.log(`  (dry run — would refund, create 2 orders, charge each, repoint rows, fix totals, cancel old)`);
    continue;
  }

  // 1) refund the tender → money back on the gift card
  const refRes = await fetch(`${SQB}/refunds`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ idempotency_key: `remediate-charged-${oldId}-refund`, payment_id: paymentId, amount_money: { amount: tenderAmt, currency: "USD" }, reason: "combo revenue split (re-allocate to FastTrax)" }),
  });
  const refData = await refRes.json();
  if (!refRes.ok || refData.errors) {
    console.log(`  ‼ REFUND FAILED: ${JSON.stringify(refData.errors ?? refData)} — aborting this order`);
    continue;
  }
  console.log(`  refunded ${refData.refund?.id} (status ${refData.refund?.status})`);

  // 2) wait for the gift card balance to reflect the refund
  let bal = 0;
  for (let i = 0; i < 10; i++) {
    bal = (await (await fetch(`${SQB}/gift-cards/${gcId}`, { headers: H })).json()).gift_card?.balance_money?.amount ?? 0;
    if (bal >= ftTotal + hpTotal) break;
    await sleep(2000);
  }
  if (bal < ftTotal + hpTotal) {
    console.log(`  ‼ gift card balance $${(bal / 100).toFixed(2)} < needed $${((ftTotal + hpTotal) / 100).toFixed(2)} after refund — aborting (refund stands; re-run later)`);
    continue;
  }

  // 3) create split orders + charge each
  const ftItems = [li(SQ.UQ, "VIP Exp - Starter Race", ppl, 1700), li(SQ.UQ, "VIP Exp - Intermediate Race", ppl, 1700), li(SQ.POV, "VIP Exp - POV Video", ppl, 500), li(SQ.LICENSE, "VIP Exp - FastTrax License", ppl, 499)];
  const hpItems = [li(SQ.VIP_BOWLING, "VIP Exp - VIP Bowling", ppl, we ? 2601 : 1601), li(SQ.SHOE, "VIP Exp - Shoes", ppl, 500), li(SQ.BOOKING_FEE, "VIP Exp - Booking Fee", 1, 299)];
  const ft = await createOrder(FASTTRAX_FM, ftItems, `remediate-charged-${oldId}-ft`, o.customer_id, 0);
  const hp = await createOrder(HEADPINZ_FM, hpItems, `remediate-charged-${oldId}-hp`, o.customer_id, hpDisc);
  const ftPay = await chargeGiftCard(ft.id, FASTTRAX_FM, gcId, ft.total, `remediate-charged-${oldId}-ft-pay`);
  const hpPay = await chargeGiftCard(hp.id, HEADPINZ_FM, gcId, hp.total, `remediate-charged-${oldId}-hp-pay`);
  console.log(`  created+charged FastTrax ${ft.id.slice(0, 8)} $${(ft.total / 100).toFixed(2)} (pay ${String(ftPay).slice(0, 8)}) + HeadPinz ${hp.id.slice(0, 8)} $${(hp.total / 100).toFixed(2)} (pay ${String(hpPay).slice(0, 8)})`);

  // 4) repoint Neon rows + fix totals
  await q`UPDATE bowling_reservations SET square_dayof_order_id = ${ft.id}, total_cents = ${ft.total}, deposit_cents = ${ft.total} WHERE id = ${raceRow.id}`;
  await q`UPDATE bowling_reservations SET square_dayof_order_id = ${hp.id}, total_cents = ${hp.total}, deposit_cents = ${hp.total} WHERE id = ${bowlRow.id}`;
  console.log(`  repointed rows #${raceRow.id}→FastTrax, #${bowlRow.id}→HeadPinz (totals fixed)`);

  // 5) cancel the old (refunded) order
  try {
    const fresh = (await (await fetch(`${SQB}/orders/${oldId}`, { headers: H })).json()).order;
    const cRes = await fetch(`${SQB}/orders/${oldId}`, { method: "PUT", headers: H, body: JSON.stringify({ idempotency_key: `remediate-charged-${oldId}-cancel`, order: { version: fresh?.version, state: "CANCELED" } }) });
    console.log(`  old order cancel: ${cRes.ok ? "OK" : `FAILED ${cRes.status} (orphaned, non-fatal)`}`);
  } catch (e) {
    console.log(`  old order cancel error (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
console.log(LIVE ? "\n=== DONE ===" : "\n=== DRY RUN COMPLETE ===");
