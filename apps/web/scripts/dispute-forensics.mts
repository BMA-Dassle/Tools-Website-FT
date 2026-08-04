/**
 * READ-ONLY: forensics for a single Square dispute.
 * Pulls dispute -> payment -> order -> refunds, and prints everything we would
 * need to decide whether to contest.
 *
 * Usage: npx tsx scripts/dispute-forensics.mts <disputeId> [<disputeId> ...]
 */
import { readFileSync } from "node:fs";

if (!process.env.SQUARE_ACCESS_TOKEN) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^SQUARE_ACCESS_TOKEN=(.+)$/m);
  if (m) process.env.SQUARE_ACCESS_TOKEN = m[1].trim().replace(/^"|"$/g, "");
}
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};

async function sq(path: string) {
  const r = await fetch(`${BASE}${path}`, { headers: H });
  const b: any = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(b.errors ?? b)}`);
  return b;
}

const usd = (m?: { amount?: number }) => `$${((m?.amount ?? 0) / 100).toFixed(2)}`;

for (const disputeId of process.argv.slice(2)) {
  const d = (await sq(`/disputes/${disputeId}`)).dispute;
  console.log("=".repeat(78));
  console.log(`DISPUTE ${disputeId}  [${d.state}]  ${usd(d.amount_money)}  ${d.reason}`);
  console.log(`  due ${d.due_at}   created ${d.created_at}   brand ref ${d.brand_dispute_id}`);
  console.log(`  location_id ${d.location_id}`);

  const paymentId = d.disputed_payment?.payment_id;
  if (!paymentId) {
    console.log("  !! no disputed payment id");
    continue;
  }

  const p = (await sq(`/payments/${paymentId}`)).payment;
  const cd = p.card_details ?? {};
  const card = cd.card ?? {};
  console.log(`\nPAYMENT ${paymentId}`);
  console.log(`  ${usd(p.amount_money)} total | tip ${usd(p.tip_money)} | refunded ${usd(p.refunded_money)}`);
  console.log(`  status ${p.status}   source ${p.source_type}   created ${p.created_at}`);
  console.log(`  location ${p.location_id}   order ${p.order_id ?? "—"}`);
  console.log(`  buyer_email ${p.buyer_email_address ?? "—"}`);
  console.log(`  card ${card.card_brand ?? "?"} ****${card.last_4 ?? "????"} exp ${card.exp_month ?? "?"}/${card.exp_year ?? "?"}`);
  console.log(`  cardholder "${card.cardholder_name ?? "—"}"`);
  console.log(`  FINGERPRINT ${card.fingerprint ?? "—"}`);
  console.log(`  entry ${cd.entry_method ?? "—"}  cvv ${cd.cvv_status ?? "—"}  avs ${cd.avs_status ?? "—"}  auth ${cd.auth_result_code ?? "—"}`);
  console.log(`  verification ${cd.verification_method ?? "—"} / ${cd.verification_results ?? "—"}`);
  console.log(`  statement descriptor "${p.statement_description_identifier ?? "—"}"`);
  console.log(`  note "${p.note ?? "—"}"`);
  console.log(`  receipt ${p.receipt_url ?? "—"}`);
  if (p.device_details) console.log(`  device ${JSON.stringify(p.device_details)}`);
  if (p.application_details) console.log(`  app ${JSON.stringify(p.application_details)}`);

  if (p.order_id) {
    const o = (await sq(`/orders/${p.order_id}`)).order;
    console.log(`\nORDER ${o.id}  state ${o.state}   created ${o.created_at}`);
    console.log(`  note "${o.note ?? "—"}"`);
    console.log(`  total ${usd(o.total_money)}  tax ${usd(o.total_tax_money)}  discount ${usd(o.total_discount_money)}`);
    if (o.reference_id) console.log(`  reference_id ${o.reference_id}`);
    if (o.customer_id) console.log(`  customer_id ${o.customer_id}`);
    for (const li of o.line_items ?? []) {
      console.log(`   - ${li.quantity} x ${li.name}${li.variation_name ? ` / ${li.variation_name}` : ""}  ${usd(li.total_money)}`);
      for (const n of li.note ? [li.note] : []) console.log(`       note: ${n}`);
    }
    for (const t of o.tenders ?? []) {
      console.log(`   tender ${t.type} ${usd(t.amount_money)} id=${t.id} payment=${t.payment_id ?? "—"}`);
    }
    for (const r of o.refunds ?? []) {
      console.log(`   REFUND ${r.status} ${usd(r.amount_money)} reason="${r.reason ?? "—"}" ${r.created_at}`);
    }
    if (o.fulfillments?.length) console.log(`  fulfillments ${JSON.stringify(o.fulfillments)}`);
  }

  const refunds = (await sq(`/refunds?location_id=${p.location_id}&begin_time=${p.created_at}`)).refunds ?? [];
  const mine = refunds.filter((r: any) => r.payment_id === paymentId);
  console.log(`\nREFUNDS against this payment: ${mine.length}`);
  for (const r of mine) console.log(`  ${r.status} ${usd(r.amount_money)} "${r.reason ?? ""}" ${r.created_at}`);
  console.log("");
}
