/**
 * READ-ONLY forensics for the 2026-07-28 17:15 UTC FastTrax kiosk orphan:
 * terminal captured $234.21 (payment l2WCuZnAfPDkNI0WcxDiZXkUc5bZY, deposit
 * order lgThVPeeX452ufC6E63Omjvhm1DZY) but reserve-all threw on the QAMF
 * createReservation(11542) 400 ("Millisecond must be 0" + PhoneNumber), so no
 * bowling reservation and no race confirm exist. Guest: Paul Chung.
 *
 * Rebuilds the cart from Square (the only place the itemization landed) plus
 * every Neon row that mentions the bill / guest. NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const ORDER_ID = "lgThVPeeX452ufC6E63Omjvhm1DZY";
const PAYMENT_ID = "l2WCuZnAfPDkNI0WcxDiZXkUc5bZY";

const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const d = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
const ts = (s: unknown) => (typeof s === "string" ? s.replace("T", " ").slice(0, 19) : "");

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j: j as Record<string, any> };
}

// ───────────────────── 1. THE PAYMENT ─────────────────────
const pay = await sq(`/payments/${PAYMENT_ID}`);
const p = pay.j.payment ?? {};
console.log(`\n════════════ PAYMENT ${PAYMENT_ID} ════════════  (${pay.status})`);
console.log(`status        ${p.status}`);
console.log(`amount        ${d(p.amount_money?.amount)}  ${p.amount_money?.currency}`);
console.log(`created       ${ts(p.created_at)}   updated ${ts(p.updated_at)}`);
console.log(`location      ${p.location_id}`);
console.log(`order_id      ${p.order_id}`);
console.log(`source        ${p.source_type}  card=${p.card_details?.card?.card_brand} ****${p.card_details?.card?.last_4} entry=${p.card_details?.entry_method}`);
console.log(`device        ${JSON.stringify(p.device_details ?? {})}`);
console.log(`refunded      ${d(p.refunded_money?.amount)}  ids=${JSON.stringify(p.refund_ids ?? [])}`);
console.log(`note          ${p.note ?? "-"}`);
console.log(`reference_id  ${p.reference_id ?? "-"}`);

// ───────────────────── 2. THE ORDER (the cart) ─────────────────────
const ord = await sq(`/orders/${ORDER_ID}`);
const o = ord.j.order ?? {};
console.log(`\n════════════ ORDER ${ORDER_ID} ════════════  (${ord.status})`);
console.log(`state         ${o.state}`);
console.log(`location      ${o.location_id}`);
console.log(`reference_id  ${o.reference_id ?? "-"}`);
console.log(`source        ${JSON.stringify(o.source ?? {})}`);
console.log(`created       ${ts(o.created_at)}   closed ${ts(o.closed_at)}`);
console.log(`total         ${d(o.total_money?.amount)}  tax ${d(o.total_tax_money?.amount)}  disc ${d(o.total_discount_money?.amount)}`);
console.log(`\n── LINE ITEMS ──`);
for (const li of o.line_items ?? []) {
  console.log(
    `  uid=${li.uid}  qty=${li.quantity}  ${d(li.total_money?.amount)}  "${li.name}"  var="${li.variation_name ?? ""}"  catalog=${li.catalog_object_id ?? "-"}  type=${li.item_type ?? "-"}`,
  );
  if (li.note) console.log(`      note: ${li.note}`);
  for (const m of li.metadata ? Object.entries(li.metadata) : []) console.log(`      meta ${m[0]}=${m[1]}`);
}
if (o.metadata) console.log(`\norder metadata  ${JSON.stringify(o.metadata)}`);
for (const t of o.tenders ?? []) {
  console.log(`tender  ${t.id}  ${t.type}  ${d(t.amount_money?.amount)}  payment=${t.payment_id ?? t.card_details?.payment_id ?? "-"}`);
}
for (const f of o.fulfillments ?? []) {
  console.log(`fulfillment  ${f.uid}  ${f.type}  ${f.state}  ${JSON.stringify(f.pickup_details?.recipient ?? {})}`);
}

// ───────────────────── 3. GIFT CARD ACTIVATED ON ATTEMPT 1 ─────────────────────
const gc = await sq(`/gift-cards/from-order-id`, {
  method: "POST",
  body: JSON.stringify({ order_id: ORDER_ID, location_id: o.location_id }),
});
console.log(`\n════════════ GIFT CARDS FROM ORDER ════════════  (${gc.status})`);
for (const c of gc.j.gift_cards ?? []) {
  console.log(`  gan=${c.gan}  id=${c.id}  state=${c.state}  balance=${d(c.balance_money?.amount)}  created=${ts(c.created_at)}`);
}
if (!gc.j.gift_cards?.length) console.log(`  (none — ${JSON.stringify(gc.j).slice(0, 300)})`);

// ───────────────────── 4. NEON: what did we persist? ─────────────────────
const { sql } = await import("@/lib/db");
const q = sql();

const bowl = (await q`
  SELECT * FROM bowling_reservations
  WHERE guest_email ILIKE '%chung1976%' OR guest_phone LIKE '%5184297%'
     OR deposit_order_id = ${ORDER_ID}
  ORDER BY id DESC LIMIT 20
`) as Array<Record<string, any>>;
console.log(`\n════════════ bowling_reservations: ${bowl.length} ════════════`);
for (const r of bowl) {
  console.log(
    `  id=${r.id} neon=${r.id} qamf=${r.qamf_reservation_id} center=${r.center_id} booked=${ts(r.booked_at)} status=${r.status} bill=${r.bmi_bill_id ?? "-"} dep=${r.deposit_order_id ?? "-"} created=${ts(r.created_at)}`,
  );
}

const cw = (await q`
  SELECT * FROM clickwrap_consents
  WHERE email ILIKE '%chung1976%' OR phone LIKE '%5184297%'
  ORDER BY id DESC LIMIT 20
`) as Array<Record<string, any>>;
console.log(`\n════════════ clickwrap_consents: ${cw.length} ════════════`);
for (const r of cw) {
  console.log(`  id=${r.id} bill=${r.bill_id} amount=${d(r.amount_cents)} type=${r.booking_type} card=${r.card_brand ?? "-"}****${r.card_last4 ?? "-"} at=${ts(r.created_at)}`);
}

for (const t of ["booking_details", "booking_records", "race_bookings", "kiosk_sessions"]) {
  const exists = (await q`SELECT to_regclass(${"public." + t}) AS r`) as Array<{ r: string | null }>;
  if (!exists[0]?.r) {
    console.log(`\n(table ${t} does not exist — skipped)`);
    continue;
  }
  const rows = (await q.query(
    `SELECT * FROM ${t} WHERE created_at > now() - interval '4 hours' ORDER BY created_at DESC LIMIT 10`,
  )) as Array<Record<string, any>>;
  console.log(`\n════════════ ${t} (last 4h): ${rows.length} ════════════`);
  for (const r of rows) console.log(`  ${JSON.stringify(r).slice(0, 400)}`);
}

console.log(`\nDONE — read-only.`);
