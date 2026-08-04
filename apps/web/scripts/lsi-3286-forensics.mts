/**
 * READ-ONLY forensics for BMI reservation #3286 (LSI Companies, FastTrax FM,
 * event 2026-06-05). Erica Brace reports 4 card charges totalling $4,659.52
 * against a $2,649.09 event. Reconstructs: the quote's money fields, the full
 * audit log, every Square payment tied to the quote's customer, every gift-card
 * load/redemption, and all refunds — so we can say exactly which charges are
 * real and which are duplicates. NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const d = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
const ts = (s: unknown) => (typeof s === "string" ? s.replace("T", " ").slice(0, 19) : "");

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j: j as Record<string, any> };
}

const { sql } = await import("@/lib/db");
const q = sql();

// ─────────────────────────── 1. THE QUOTE ───────────────────────────
const rows = (await q`
  SELECT * FROM group_function_quotes
  WHERE bmi_reservation_id = '3286' OR event_number = '3286'
     OR event_name ILIKE '%LSI%'
  ORDER BY id
`) as Array<Record<string, any>>;

console.log(`\n════════════ MATCHED QUOTES: ${rows.length} ════════════`);
for (const r of rows) {
  console.log(
    `  id=${r.id}  bmi=${r.bmi_reservation_id}  evt#=${r.event_number}  "${r.event_name}"  ${ts(r.event_date)}  center=${r.center_code}  status=${r.status}  short=${r.contract_short_id}`,
  );
}
if (!rows.length) process.exit(1);

for (const quote of rows) {
  console.log(`\n\n██████████ QUOTE ${quote.id} — ${quote.event_name} (#${quote.event_number}) ██████████`);
  console.log(`center             ${quote.center_code} / ${quote.center_name}  loc=${quote.square_location_id}`);
  console.log(`guest              ${quote.guest_first_name} ${quote.guest_last_name} <${quote.guest_email}>`);
  console.log(`planner            ${quote.planner_first} ${quote.planner_last} <${quote.planner_email}>`);
  console.log(`event_date         ${ts(quote.event_date)}  (${quote.event_date_display})`);
  console.log(`guest_count        ${quote.guest_count}`);
  console.log(`status             ${quote.status}   tax_exempt=${quote.is_tax_exempt}`);
  console.log(`created / updated  ${ts(quote.created_at)} / ${ts(quote.updated_at)}`);

  console.log(`\n── MONEY (as recorded) ──`);
  console.log(`total_cents         ${d(quote.total_cents)}`);
  console.log(`tax_cents           ${d(quote.tax_cents)}`);
  console.log(`deposit_due_cents   ${d(quote.deposit_due_cents)}`);
  console.log(`balance_cents       ${d(quote.balance_cents)}`);
  console.log(`collected_cents     ${d(quote.collected_cents)}`);
  console.log(`deposit_paid_at     ${ts(quote.deposit_paid_at) || "(none)"}`);
  console.log(`balance_paid_at     ${ts(quote.balance_paid_at) || "(none)"}   method=${quote.balance_payment_method ?? "-"}`);
  console.log(`dayof_paid_at       ${ts(quote.dayof_paid_at) || "(none)"}`);
  console.log(`balance_attempts    ${quote.balance_charge_attempts}   last_err=${quote.balance_last_error ?? "-"}`);
  console.log(`deposit_attempts    ${quote.deposit_attempts}   last_err=${quote.deposit_last_error ?? "-"}`);
  console.log(`decline             ${quote.balance_decline_code ?? "-"} ${quote.balance_decline_message ?? ""} ${ts(quote.balance_declined_at)}`);
  console.log(`saved_card          ${quote.saved_card_id ? `${quote.saved_card_brand} ****${quote.saved_card_last4} (${quote.saved_card_id})` : "(none)"}`);
  console.log(`square_customer_id  ${quote.square_customer_id ?? "-"}`);

  console.log(`\n── SQUARE IDS ON THE ROW ──`);
  console.log(`deposit_order    ${quote.square_deposit_order_id ?? "-"}`);
  console.log(`deposit_payment  ${quote.square_deposit_payment_id ?? "-"}`);
  console.log(`balance_order    ${quote.square_balance_order_id ?? "-"}`);
  console.log(`balance_payment  ${quote.square_balance_payment_id ?? "-"}`);
  console.log(`balance_link_id  ${quote.square_balance_link_id ?? "-"}`);
  console.log(`dayof_order      ${quote.square_dayof_order_id ?? "-"}`);
  console.log(`settled_order    ${quote.square_settled_order_id ?? "-"}`);
  console.log(`dayof_payment_ids ${JSON.stringify(quote.dayof_payment_ids)}`);
  console.log(`gift_card_ids    ${quote.square_gift_card_id ?? "-"}`);
  console.log(`gift_card_gans   ${quote.square_gift_card_gan ?? "-"}`);

  console.log(`\n── QUOTE LINE ITEMS ──`);
  for (const li of (quote.line_items ?? []) as Array<Record<string, any>>) {
    console.log(`  ${JSON.stringify(li)}`);
  }
  console.log(`\n── PRIOR PAYMENTS (from Hermes) ──`);
  for (const p of (quote.prior_payments ?? []) as Array<Record<string, any>>) {
    console.log(`  ${JSON.stringify(p)}`);
  }

  // ─────────────────────── 2. AUDIT LOG ───────────────────────
  const log = (await q`
    SELECT event, actor_email, metadata, created_at
    FROM contract_audit_log WHERE quote_id = ${quote.id} ORDER BY id
  `) as Array<Record<string, any>>;
  console.log(`\n── AUDIT LOG (${log.length}) ──`);
  for (const e of log) {
    console.log(`  ${ts(e.created_at)}  ${e.event.padEnd(28)} ${e.actor_email ?? ""}  ${JSON.stringify(e.metadata)}`);
  }

  // ─────────────────── 3. EVENT NOTIFICATIONS ───────────────────
  const notifs = (await q`
    SELECT * FROM group_function_notifications WHERE quote_id = ${quote.id} ORDER BY id
  `.catch(() => [])) as Array<Record<string, any>>;
  if (notifs.length) {
    console.log(`\n── NOTIFICATIONS (${notifs.length}) ──`);
    for (const n of notifs) console.log(`  ${ts(n.created_at)} ${JSON.stringify(n)}`);
  }

  // ─────────────────── 4. ORDERS ON THE ROW ───────────────────
  const orderIds = [
    ["deposit", quote.square_deposit_order_id],
    ["balance", quote.square_balance_order_id],
    ["balance_link", quote.square_balance_link_id],
    ["dayof", quote.square_dayof_order_id],
    ["settled", quote.square_settled_order_id],
  ].filter(([, id]) => id) as Array<[string, string]>;

  for (const [label, id] of orderIds) {
    const { ok, status, j } = await sq(`/orders/${id}`);
    console.log(`\n══════ ORDER [${label}] ${id} ══════`);
    if (!ok || !j.order) {
      console.log(`  fetch failed HTTP ${status} ${JSON.stringify(j).slice(0, 300)}`);
      continue;
    }
    const o = j.order;
    console.log(`  name="${o.name ?? ""}" state=${o.state} loc=${o.location_id} created=${ts(o.created_at)} closed=${ts(o.closed_at)}`);
    console.log(
      `  total=${d(money(o.total_money))} tax=${d(money(o.total_tax_money))} svc=${d(money(o.total_service_charge_money))} disc=${d(money(o.total_discount_money))} tipped=${d(money(o.total_tip_money))} due=${d(money(o.net_amount_due_money))}`,
    );
    for (const l of (o.line_items ?? []) as Array<Record<string, any>>) {
      console.log(`    • uid=${l.uid} ${l.quantity}× "${l.name}" base=${d(money(l.base_price_money))} total=${d(money(l.total_money))} cat=${l.catalog_object_id ?? "-"}`);
    }
    for (const s of (o.service_charges ?? []) as Array<Record<string, any>>) {
      console.log(`    svc-chg "${s.name}" ${d(money(s.total_money))} pct=${s.percentage ?? "-"}`);
    }
    for (const r of (o.returns ?? []) as Array<Record<string, any>>) {
      console.log(`    RETURN uid=${r.uid} src_order=${r.source_order_id} lines=${(r.return_line_items ?? []).length}`);
      for (const rl of (r.return_line_items ?? []) as Array<Record<string, any>>) {
        console.log(`      ↩ ${rl.quantity}× "${rl.name}" src_uid=${rl.source_line_item_uid} total=${d(money(rl.total_money))}`);
      }
    }
    if (o.return_amounts) console.log(`    return_amounts total=${d(money(o.return_amounts.total_money))} tax=${d(money(o.return_amounts.tax_money))}`);
    for (const t of (o.tenders ?? []) as Array<Record<string, any>>) {
      console.log(
        `    TENDER ${t.id} type=${t.type} amount=${d(money(t.amount_money))} payment_id=${t.payment_id ?? t.card_details?.payment_id ?? "-"} card=${t.card_details?.card?.card_brand ?? ""}****${t.card_details?.card?.last_4 ?? ""} created=${ts(t.created_at)}`,
      );
    }
    for (const rf of (o.refunds ?? []) as Array<Record<string, any>>) {
      console.log(`    REFUND ${rf.id} status=${rf.status} amount=${d(money(rf.amount_money))} reason="${rf.reason ?? ""}" created=${ts(rf.created_at)}`);
    }
  }

  // ─────────── 5. ALL PAYMENTS FOR THIS CUSTOMER ───────────
  if (quote.square_customer_id) {
    console.log(`\n\n══════ ALL SQUARE PAYMENTS for customer ${quote.square_customer_id} ══════`);
    let cursor: string | undefined;
    let n = 0;
    do {
      const qs = new URLSearchParams({
        begin_time: "2026-01-01T00:00:00Z",
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const { j } = await sq(`/payments?${qs}`);
      for (const p of (j.payments ?? []) as Array<Record<string, any>>) {
        if (p.customer_id !== quote.square_customer_id) continue;
        n++;
        console.log(
          `  ${ts(p.created_at)} ${p.id} ${d(money(p.amount_money))} ${p.status} src=${p.source_type} ${p.card_details?.card?.card_brand ?? ""}****${p.card_details?.card?.last_4 ?? ""} order=${p.order_id} refunded=${d(money(p.refunded_money))} note="${p.note ?? ""}"`,
        );
      }
      cursor = j.cursor;
    } while (cursor);
    console.log(`  (${n} payments for this customer)`);
  }

  // ─────────── 6. GIFT CARDS: balances + FULL activity ───────────
  const { parseGiftCardIds, parseGiftCardGans } = await import("@/lib/group-function-db");
  const gcIds = parseGiftCardIds(quote.square_gift_card_id);
  const gcGans = parseGiftCardGans(quote.square_gift_card_gan);
  console.log(`\n\n══════ GIFT CARDS (${gcIds.length}) ══════`);
  let gcBalTotal = 0;
  for (let i = 0; i < gcIds.length; i++) {
    const { j } = await sq(`/gift-cards/${gcIds[i]}`);
    const gc = j.gift_card ?? {};
    const bal = money(gc.balance_money);
    gcBalTotal += bal;
    console.log(`\n  [${i}] ${gcIds[i]}  gan=${gcGans[i] ?? gc.gan ?? "?"}  state=${gc.state}  BALANCE=${d(bal)}`);
    const { j: aj } = await sq(`/gift-cards/activities?gift_card_id=${gcIds[i]}&limit=100&sort_order=ASC`);
    for (const a of (aj.gift_card_activities ?? []) as Array<Record<string, any>>) {
      const amt = money(a[`${String(a.type).toLowerCase()}_activity_details`]?.amount_money) || money(a.amount_money);
      const det = a.activate_activity_details ?? a.load_activity_details ?? a.redeem_activity_details ?? a.refund_activity_details ?? a.adjust_increment_activity_details ?? a.adjust_decrement_activity_details ?? {};
      console.log(
        `      ${ts(a.created_at)} ${String(a.type).padEnd(18)} ${d(amt || money(det.amount_money))} bal_after=${d(money(a.gift_card_balance_money))} order=${det.order_id ?? "-"} line=${det.line_item_uid ?? "-"} payment=${det.payment_id ?? "-"} ref=${det.reference_id ?? "-"}`,
      );
    }
  }
  console.log(`\n  >>> TOTAL REMAINING GIFT-CARD BALANCE = ${d(gcBalTotal)}`);

  // ─────────── 7. REFUNDS at this location in window ───────────
  console.log(`\n\n══════ REFUNDS (location ${quote.square_location_id}, Jun–Jul 2026) ══════`);
  {
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({
        begin_time: "2026-06-01T00:00:00Z",
        location_id: quote.square_location_id,
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const { j } = await sq(`/refunds?${qs}`);
      for (const r of (j.refunds ?? []) as Array<Record<string, any>>) {
        console.log(`  ${ts(r.created_at)} ${r.id} ${d(money(r.amount_money))} ${r.status} payment=${r.payment_id} order=${r.order_id} reason="${r.reason ?? ""}"`);
      }
      cursor = j.cursor;
    } while (cursor);
  }
}

process.exit(0);
