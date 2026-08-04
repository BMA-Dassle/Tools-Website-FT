/**
 * READ-ONLY. Hunts every Square payment on VISA ****0287 (Erica Brace / LSI
 * Companies, BMI #3286) across ALL merchant locations for June 2026, plus any
 * payment matching the two disputed amounts ($1,497.31 / $513.12). Also dumps
 * the abandoned pre-re-ring day-of order and the three intermediate gift-card
 * redemption payments. NO WRITES.
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
const ts = (s: unknown) =>
  s instanceof Date ? s.toISOString().replace("T", " ").slice(0, 19) : typeof s === "string" ? s.replace("T", " ").slice(0, 19) : "";

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, j: j as Record<string, any> };
}

const LAST4 = "0287";
const TARGETS = new Set([149731, 51312, 115178, 264909]);

// ── locations ──
const { j: lj } = await sq(`/locations`);
const locs = (lj.locations ?? []) as Array<Record<string, any>>;
console.log(`══════ LOCATIONS (${locs.length}) ══════`);
for (const l of locs) console.log(`  ${l.id}  ${l.name}  status=${l.status}`);

// ── sweep payments per location for June 2026 ──
const hits: Array<Record<string, any>> = [];
for (const loc of locs) {
  let cursor: string | undefined;
  let count = 0;
  do {
    const qs = new URLSearchParams({
      location_id: loc.id,
      begin_time: "2026-05-25T00:00:00Z",
      end_time: "2026-07-01T00:00:00Z",
      sort_order: "ASC",
      limit: "100",
    });
    if (cursor) qs.set("cursor", cursor);
    const { ok, j } = await sq(`/payments?${qs}`);
    if (!ok) {
      console.log(`  ! ${loc.name}: ${JSON.stringify(j).slice(0, 200)}`);
      break;
    }
    for (const p of (j.payments ?? []) as Array<Record<string, any>>) {
      count++;
      const l4 = p.card_details?.card?.last_4 ?? "";
      const amt = money(p.amount_money);
      if (l4 === LAST4 || TARGETS.has(amt)) {
        hits.push({ ...p, _loc: loc.name });
      }
    }
    cursor = j.cursor;
  } while (cursor);
  console.log(`  swept ${loc.name}: ${count} payments`);
}

console.log(`\n\n══════ MATCHES (card ****${LAST4} OR amount in {${[...TARGETS].map((t) => d(t)).join(", ")}}) — ${hits.length} ══════`);
hits.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
for (const p of hits) {
  const c = p.card_details?.card ?? {};
  console.log(
    `\n  ${ts(p.created_at)}  ${p.id}\n    amount=${d(money(p.amount_money))} tip=${d(money(p.tip_money))} total=${d(money(p.total_money))} refunded=${d(money(p.refunded_money))}\n    status=${p.status} src=${p.source_type} ${c.card_brand ?? ""}****${c.last_4 ?? ""} exp=${c.exp_month ?? ""}/${c.exp_year ?? ""} fp=${c.fingerprint ?? "-"}\n    loc=${p._loc} (${p.location_id}) order=${p.order_id} customer=${p.customer_id ?? "-"}\n    entry=${p.card_details?.entry_method ?? "-"} app=${p.application_details?.square_product ?? "-"} team=${p.team_member_id ?? "-"} note="${p.note ?? ""}" receipt=${p.receipt_number ?? "-"}`,
  );
}

// ── the abandoned pre-re-ring day-of order + intermediate GC payments ──
const EXTRA_ORDERS = ["5oqd300NUqjYt9i5CZ6gZKRKUsXZY"];
const EXTRA_PAYMENTS = [
  "5GZusbWBaYNFvjq1ytH52SzWyjMZY",
  "9Caw2sqMyvNhMnOCwAvxgH4hHZAZY",
  "fJHvNw7TRQSUxG0oBnkrTz3bw6dZY",
];

for (const id of EXTRA_ORDERS) {
  const { ok, status, j } = await sq(`/orders/${id}`);
  console.log(`\n\n══════ ABANDONED / PRE-RE-RING ORDER ${id} ══════`);
  if (!ok || !j.order) {
    console.log(`  HTTP ${status} ${JSON.stringify(j).slice(0, 300)}`);
    continue;
  }
  const o = j.order;
  console.log(`  state=${o.state} loc=${o.location_id} created=${ts(o.created_at)} closed=${ts(o.closed_at)}`);
  console.log(`  total=${d(money(o.total_money))} tax=${d(money(o.total_tax_money))} svc=${d(money(o.total_service_charge_money))} due=${d(money(o.net_amount_due_money))}`);
  for (const l of (o.line_items ?? []) as Array<Record<string, any>>) {
    console.log(`    • uid=${l.uid} ${l.quantity}× "${l.name}" base=${d(money(l.base_price_money))} total=${d(money(l.total_money))}`);
  }
  for (const r of (o.returns ?? []) as Array<Record<string, any>>) {
    for (const rl of (r.return_line_items ?? []) as Array<Record<string, any>>) {
      console.log(`    ↩ ${rl.quantity}× "${rl.name}" total=${d(money(rl.total_money))}`);
    }
  }
  if (o.return_amounts) console.log(`    return_amounts total=${d(money(o.return_amounts.total_money))}`);
  for (const t of (o.tenders ?? []) as Array<Record<string, any>>) {
    console.log(`    TENDER ${t.id} type=${t.type} amount=${d(money(t.amount_money))}`);
  }
  for (const rf of (o.refunds ?? []) as Array<Record<string, any>>) {
    console.log(`    REFUND ${rf.id} ${d(money(rf.amount_money))} ${rf.status} "${rf.reason ?? ""}"`);
  }
}

for (const id of EXTRA_PAYMENTS) {
  const { ok, j } = await sq(`/payments/${id}`);
  const p = j.payment;
  console.log(`\n── payment ${id} ──`);
  if (!ok || !p) {
    console.log(`  ${JSON.stringify(j).slice(0, 200)}`);
    continue;
  }
  console.log(
    `  ${ts(p.created_at)} ${d(money(p.amount_money))} ${p.status} src=${p.source_type} order=${p.order_id} refunded=${d(money(p.refunded_money))} note="${p.note ?? ""}"`,
  );
}

// ── all orders referencing #3286 / LSI at FT ──
console.log(`\n\n══════ SEARCH ORDERS at FastTrax FM, Jun 1–10, naming LSI/3286 ══════`);
{
  const body = {
    location_ids: ["LAB52GY480CJF"],
    query: {
      filter: { date_time_filter: { created_at: { start_at: "2026-06-01T00:00:00Z", end_at: "2026-06-10T00:00:00Z" } } },
      sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
    },
    limit: 500,
  };
  let cursor: string | undefined;
  do {
    const { ok, j } = await sq(`/orders/search`, {
      method: "POST",
      body: JSON.stringify(cursor ? { ...body, cursor } : body),
    });
    if (!ok) {
      console.log(`  ${JSON.stringify(j).slice(0, 300)}`);
      break;
    }
    for (const o of (j.orders ?? []) as Array<Record<string, any>>) {
      const blob = JSON.stringify(o);
      if (!/LSI|3286|47914983|Brace/i.test(blob)) continue;
      console.log(
        `\n  ${ts(o.created_at)} order=${o.id} name="${o.name ?? ""}" state=${o.state} total=${d(money(o.total_money))} src="${o.source?.name ?? ""}"`,
      );
      for (const l of (o.line_items ?? []) as Array<Record<string, any>>) {
        console.log(`      • ${l.quantity}× "${l.name}" ${d(money(l.total_money))}`);
      }
      for (const t of (o.tenders ?? []) as Array<Record<string, any>>) {
        console.log(`      TENDER ${t.type} ${d(money(t.amount_money))} pay=${t.payment_id ?? t.id} ${t.card_details?.card?.card_brand ?? ""}****${t.card_details?.card?.last_4 ?? ""}`);
      }
    }
    cursor = j.cursor;
  } while (cursor);
}

process.exit(0);
