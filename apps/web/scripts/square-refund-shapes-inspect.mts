/**
 * READ-ONLY. What do REAL refunds in our Square account look like — especially
 * any that went back to a gift card?
 *
 * The probes established that a refund linked to a return order does not
 * credit the gift-card tender, and that destination_id does not change it. But
 * probe-built payments report source_type=CARD with gift_card_details=null
 * even though they were paid with source_id=<gift card id>. That smells like
 * the probe is not producing a TRUE gift-card tender, which would make the
 * whole comparison suspect.
 *
 * So look at production: list recent refunds, pull each one's payment, and
 * report the shapes actually in use — destination types, source types, whether
 * a real GIFT_CARD tender exists, and whether any refund carries an order_id.
 *
 * Writes nothing. Touches every location (read-only listing).
 *
 *   npx tsx scripts/square-refund-shapes-inspect.mts [days]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const DAYS = Number(process.argv[2] ?? 45);
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};

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

const begin = new Date(Date.now() - DAYS * 86400_000).toISOString();
const refunds: any[] = [];
let cursor: string | undefined;
for (let page = 0; page < 12; page++) {
  const p = new URLSearchParams({ begin_time: begin, sort_order: "DESC", limit: "100" });
  if (cursor) p.set("cursor", cursor);
  const r = await sq(`/refunds?${p}`);
  if (!r.ok) {
    console.log(`list refunds failed: ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 200)}`);
    break;
  }
  refunds.push(...(r.json.refunds ?? []));
  cursor = r.json.cursor;
  if (!cursor) break;
}
console.log(`${refunds.length} refunds in the last ${DAYS} days\n`);

// ── Destination types across all refunds ────────────────────────────────────
const byDest = new Map<string, number>();
const withOrder = refunds.filter((r) => r.order_id).length;
for (const r of refunds) {
  const k = String(r.destination_type ?? "(none)");
  byDest.set(k, (byDest.get(k) ?? 0) + 1);
}
console.log("destination_type distribution:");
for (const [k, v] of [...byDest].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log(`refunds carrying an order_id: ${withOrder}/${refunds.length}\n`);

// ── Any refund whose DESTINATION was a gift card ────────────────────────────
const gcDest = refunds.filter((r) => String(r.destination_type ?? "").toUpperCase().includes("GIFT"));
console.log(`refunds with a GIFT_CARD destination_type: ${gcDest.length}`);
for (const r of gcDest.slice(0, 5)) {
  console.log(`  ${r.id}`);
  console.log(`    amount=${r.amount_money?.amount}¢ status=${r.status} order_id=${r.order_id ?? "none"}`);
  console.log(`    destination_id=${r.destination_id ?? "none"} details=${JSON.stringify(r.destination_details ?? null)}`);
}

// ── Sample the underlying PAYMENTS to find true gift-card tenders ───────────
console.log("\nsampling payments behind recent refunds…");
const seen = new Set<string>();
const srcTypes = new Map<string, number>();
const giftCardPayments: any[] = [];
for (const r of refunds.slice(0, 60)) {
  const pid = r.payment_id;
  if (!pid || seen.has(pid)) continue;
  seen.add(pid);
  const p = (await sq(`/payments/${pid}`)).json?.payment;
  if (!p) continue;
  const st = String(p.source_type ?? "(none)");
  srcTypes.set(st, (srcTypes.get(st) ?? 0) + 1);
  if (st.toUpperCase().includes("GIFT") || p.gift_card_details) {
    giftCardPayments.push({ refund: r, payment: p });
  }
}
console.log("source_type of payments behind refunds:");
for (const [k, v] of [...srcTypes].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

console.log(`\nTRUE gift-card-tender payments that were refunded: ${giftCardPayments.length}`);
for (const { refund, payment } of giftCardPayments.slice(0, 6)) {
  console.log(`  refund ${refund.id}`);
  console.log(`    refund: amount=${refund.amount_money?.amount}¢ status=${refund.status} ` +
    `dest_type=${refund.destination_type ?? "none"} order_id=${refund.order_id ?? "none"}`);
  console.log(`    payment: ${payment.id} source_type=${payment.source_type} ` +
    `amount=${payment.amount_money?.amount}¢ refunded=${payment.refunded_money?.amount ?? 0}¢`);
  console.log(`    gift_card_details=${JSON.stringify(payment.gift_card_details ?? null)}`);
}

// ── How do OUR OWN internal deposit cards get funded/credited today? ────────
// Look at a recent WEBHPFM/WEBFT-style card's activity mix for a REFUND entry.
console.log("\nlooking for a real REFUND activity on any internal deposit card…");
const { neon } = await import("@neondatabase/serverless");
const db = neon(process.env.DATABASE_URL!);
const cards = (await db`
  SELECT square_gift_card_id, square_gift_card_gan, id
  FROM bowling_reservations
  WHERE square_gift_card_id IS NOT NULL AND dayof_payment_id IS NOT NULL
  ORDER BY id DESC LIMIT 25
`) as Array<Record<string, unknown>>;
let found = 0;
for (const c of cards) {
  const gcId = String(c.square_gift_card_id);
  const a = await sq(`/gift-cards/activities?gift_card_id=${encodeURIComponent(gcId)}&limit=30`);
  const types = (a.json?.gift_card_activities ?? []).map((x: any) => x.type);
  if (types.includes("REFUND")) {
    found++;
    console.log(`  res ${c.id} card ${c.square_gift_card_gan}: [${types.join(", ")}]`);
    const ref = (a.json.gift_card_activities ?? []).find((x: any) => x.type === "REFUND");
    console.log(`    REFUND activity: ${JSON.stringify(ref?.refund_activity_details ?? ref).slice(0, 300)}`);
    if (found >= 3) break;
  }
}
if (found === 0) {
  console.log(
    `  none of the last ${cards.length} internal deposit cards has a REFUND activity — ` +
      `consistent with day-of refunds never having been done in production before now`,
  );
}
