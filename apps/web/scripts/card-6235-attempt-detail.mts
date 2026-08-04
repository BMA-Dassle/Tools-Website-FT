/**
 * READ-ONLY follow-up on the ****6235 guest (2026-07-28).
 *
 * The sweep found exactly two Square authorizations on that card, 36s apart, on
 * ONE order (B8MYQJjNOGv4IZtl0f2UfSTRCqRZY): $346.12 COMPLETED then $346.12
 * CANCELED. Neither declined. Deposit note carries GAN WEBHPFM06501987, which
 * decomposes to BMI bill 63000000006501987.
 *
 * This resolves: who the guest is, what the booking was, every reserve attempt
 * behind it (with FULL error text), and whether the money has a reservation.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-attempt-detail.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const d = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
const et = (s: unknown) => {
  if (!s) return "-";
  const dt = new Date(String(s));
  if (Number.isNaN(dt.getTime())) return String(s);
  return dt.toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(",", "");
};
async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j: j as Record<string, any> };
}

const ORDER = "B8MYQJjNOGv4IZtl0f2UfSTRCqRZY";
const CUSTOMER = "S136F7KHC9Y27ZSPXKA1KEKQCM";
const BILL = "63000000006501987";
const GAN = "WEBHPFM06501987";
const FINGERPRINT =
  "sq-1-mJQFyFhnOoGWU4ncunTTpzU4jYlEAx8oATGDKirdtbvv9GXrG3nGrKuMsBMxZL3UgQ";

// ── who ──
console.log(`══════ SQUARE CUSTOMER ${CUSTOMER} ══════`);
{
  const { ok, j } = await sq(`/customers/${CUSTOMER}`);
  const c = j.customer;
  if (!ok || !c) console.log(`  ${JSON.stringify(j).slice(0, 300)}`);
  else
    console.log(
      `  ${c.given_name ?? ""} ${c.family_name ?? ""} | ${c.email_address ?? "-"} | ${c.phone_number ?? "-"}` +
        `\n  created=${et(c.created_at)} ref=${c.reference_id ?? "-"} note="${c.note ?? ""}"`,
    );
}

// ── the deposit order ──
console.log(`\n══════ DEPOSIT ORDER ${ORDER} ══════`);
{
  const { ok, j } = await sq(`/orders/${ORDER}`);
  const o = j.order;
  if (!ok || !o) console.log(`  ${JSON.stringify(j).slice(0, 400)}`);
  else {
    console.log(
      `  state=${o.state} loc=${o.location_id} created=${et(o.created_at)} updated=${et(o.updated_at)} closed=${et(o.closed_at)}` +
        `\n  total=${d(money(o.total_money))} tax=${d(money(o.total_tax_money))} due=${d(money(o.net_amount_due_money))} ref=${o.reference_id ?? "-"} src="${o.source?.name ?? ""}"`,
    );
    for (const l of (o.line_items ?? []) as any[])
      console.log(`    • ${l.quantity}× "${l.name}" ${d(money(l.total_money))} uid=${l.uid}`);
    for (const t of (o.tenders ?? []) as any[])
      console.log(
        `    TENDER ${t.id} type=${t.type} ${d(money(t.amount_money))} pay=${t.payment_id ?? "-"} ****${t.card_details?.card?.last_4 ?? ""} status=${t.card_details?.status ?? "-"}`,
      );
    for (const f of (o.fulfillments ?? []) as any[])
      console.log(`    FULFILLMENT ${f.uid} ${f.type} ${f.state}`);
  }
}

// ── every payment that ever touched this card (any last4, 30 days) ──
console.log(`\n══════ ALL PAYMENTS ON THIS CARD FINGERPRINT (30d, all locations) ══════`);
{
  const { j: lj } = await sq(`/locations`);
  const locs = ((lj.locations ?? []) as any[]).filter((l) => l.status === "ACTIVE");
  const hits: any[] = [];
  for (const loc of locs) {
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({
        location_id: loc.id,
        begin_time: "2026-06-28T00:00:00Z",
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const { ok, j } = await sq(`/payments?${qs}`);
      if (!ok) break;
      for (const p of (j.payments ?? []) as any[]) {
        if (p.card_details?.card?.fingerprint === FINGERPRINT) hits.push({ ...p, _loc: loc.name });
      }
      cursor = j.cursor;
    } while (cursor);
  }
  hits.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  console.log(`  ${hits.length} payment(s)`);
  for (const p of hits)
    console.log(
      `  ${et(p.created_at)} ET ${p.id} ${d(money(p.amount_money))} ${p.status} ****${p.card_details?.card?.last_4} ` +
        `loc=${p._loc} order=${p.order_id ?? "-"} note="${p.note ?? ""}" err=${JSON.stringify(p.card_details?.errors ?? [])}`,
    );
}

// ── the gift card behind the GAN ──
console.log(`\n══════ GIFT CARD ${GAN} ══════`);
{
  const { ok, j } = await sq(`/gift-cards/from-gan`, {
    method: "POST",
    body: JSON.stringify({ gan: GAN }),
  });
  const g = j.gift_card;
  if (!ok || !g) console.log(`  ${JSON.stringify(j).slice(0, 300)}`);
  else {
    console.log(
      `  id=${g.id} state=${g.state} BALANCE=${d(money(g.balance_money))} created=${et(g.created_at)} type=${g.type}`,
    );
    // Full ledger — every load / redeem / adjust against this GAN.
    const qs = new URLSearchParams({ gift_card_id: g.id, limit: "100", sort_order: "ASC" });
    const { ok: aok, j: aj } = await sq(`/gift-card-activities?${qs}`);
    if (!aok) console.log(`  activities: ${JSON.stringify(aj).slice(0, 300)}`);
    else {
      const acts = (aj.gift_card_activities ?? []) as any[];
      console.log(`  ── ${acts.length} activity(ies) ──`);
      let running = 0;
      for (const a of acts) {
        const amt = money(a.gift_card_activity_amount_money ?? a.load_activity_details?.amount_money);
        const signed = /REDEEM|DEACTIVATE|TRANSFER_BALANCE_FROM|ADJUST_DECREMENT/.test(a.type) ? -amt : amt;
        running += signed;
        const det =
          a.load_activity_details ??
          a.redeem_activity_details ??
          a.activate_activity_details ??
          a.refund_activity_details ??
          a.adjust_decrement_activity_details ??
          a.adjust_increment_activity_details ??
          {};
        console.log(
          `    ${et(a.created_at)} ET  ${a.type.padEnd(22)} ${d(signed).padStart(10)}` +
            `  balance_after=${d(money(a.gift_card_balance_money))}` +
            `  order=${det.order_id ?? "-"} pay=${det.payment_id ?? "-"} ref=${det.reference_id ?? "-"} loc=${a.location_id}`,
        );
      }
      console.log(`  ── computed net of activities = ${d(running)} ──`);
    }
  }
}

// ── reserve attempts: by bill, and everything in the 17:00–18:00 ET window ──
const sql = neon(process.env.DATABASE_URL!);
function dumpAttempt(a: any) {
  console.log(
    `\n  #${a.id} ${et(a.created_at)} ET → ${et(a.completed_at)}  state=${a.state}` +
      `\n     surface=${a.surface} center=${a.center ?? "-"} loc=${a.location_id ?? "-"} src=${a.payment_source}` +
      `\n     charge=${d(a.charge_cents)} bill=${a.bill_id ?? "-"} base_key=${a.base_key}` +
      `\n     deposit_order=${a.deposit_order_id ?? "-"} deposit_payment=${a.deposit_payment_id ?? "-"}` +
      `\n     neon_ids=${JSON.stringify(a.neon_ids)} qamf=${JSON.stringify(a.qamf_reservation_ids)} bmi=${a.bmi_reservation_number ?? "-"}` +
      `\n     dropped=${JSON.stringify(a.dropped_legs)} failed_step=${a.failed_step ?? "-"}` +
      `\n     cart=${JSON.stringify(a.cart)}` +
      (a.error ? `\n     ERROR ▼\n${String(a.error).split("\n").map((l: string) => "       " + l).join("\n")}` : ""),
  );
}

console.log(`\n\n══════ reserve_attempts WHERE bill_id=${BILL} ══════`);
for (const a of (await sql`SELECT * FROM reserve_attempts WHERE bill_id = ${BILL} ORDER BY created_at`) as any[])
  dumpAttempt(a);

console.log(`\n\n══════ reserve_attempts touching order/payment ${ORDER} ══════`);
for (const a of (await sql`
  SELECT * FROM reserve_attempts
  WHERE deposit_order_id = ${ORDER}
     OR deposit_payment_id IN ('rTZTtfIt7nwtUN2Gynlz9AcVXoOZY','v512IdECN2zcMnlPUZe0JCfeG6EZY')
  ORDER BY created_at`) as any[])
  dumpAttempt(a);

console.log(`\n\n══════ ALL reserve_attempts 2026-07-28 20:30–22:30 UTC (16:30–18:30 ET) ══════`);
for (const a of (await sql`
  SELECT * FROM reserve_attempts
  WHERE created_at >= '2026-07-28T20:30:00Z' AND created_at < '2026-07-28T22:30:00Z'
  ORDER BY created_at`) as any[])
  dumpAttempt(a);

console.log(`\n\n══════ EVERY failed reserve_attempt in the last 48h ══════`);
for (const a of (await sql`
  SELECT * FROM reserve_attempts
  WHERE state <> 'completed' AND created_at > NOW() - INTERVAL '48 hours'
  ORDER BY created_at`) as any[])
  dumpAttempt(a);

process.exit(0);
