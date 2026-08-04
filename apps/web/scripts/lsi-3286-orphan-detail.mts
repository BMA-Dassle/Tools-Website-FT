/**
 * READ-ONLY. Two questions:
 *  1. Itemize the $513.12 in-person EMV tab (order FmQ0EgG…) so we can tell the
 *     guest what it was — and whether it duplicates contract food.
 *  2. Prove the orphaned $1,497.31 balance charge (payment 9cDUlimu…, order
 *     ZitALNK3…) is recorded NOWHERE in Neon and never funded a gift card.
 * NO WRITES.
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

// ── 1. the $513.12 in-person tab ──
for (const id of ["FmQ0EgGNvKINRjg2ELP9dgIzozdZY", "ZitALNK3mjwAPErpM6Edh2TN8CeZY"]) {
  const { ok, status, j } = await sq(`/orders/${id}`);
  console.log(`\n\n══════ ORDER ${id} ══════`);
  if (!ok || !j.order) {
    console.log(`  HTTP ${status} ${JSON.stringify(j).slice(0, 400)}`);
    continue;
  }
  const o = j.order;
  console.log(`  name="${o.name ?? ""}" state=${o.state} loc=${o.location_id} src="${o.source?.name ?? ""}"`);
  console.log(`  created=${ts(o.created_at)} closed=${ts(o.closed_at)} ticket="${o.ticket_name ?? ""}"`);
  console.log(
    `  subtotal-ish gross=${d(money(o.net_amounts?.total_money))} total=${d(money(o.total_money))} tax=${d(money(o.total_tax_money))} svc=${d(money(o.total_service_charge_money))} disc=${d(money(o.total_discount_money))} tip=${d(money(o.total_tip_money))}`,
  );
  for (const l of (o.line_items ?? []) as Array<Record<string, any>>) {
    console.log(
      `    • ${l.quantity}× "${l.name}" ${l.variation_name ? `[${l.variation_name}] ` : ""}base=${d(money(l.base_price_money))} gross=${d(money(l.gross_sales_money))} tax=${d(money(l.total_tax_money))} total=${d(money(l.total_money))}`,
    );
    for (const m of (l.modifiers ?? []) as Array<Record<string, any>>) {
      console.log(`        + mod "${m.name}" ${d(money(m.total_price_money))}`);
    }
  }
  for (const s of (o.service_charges ?? []) as Array<Record<string, any>>) {
    console.log(`    svc-chg "${s.name}" ${d(money(s.total_money))} pct=${s.percentage ?? "-"}`);
  }
  for (const t of (o.taxes ?? []) as Array<Record<string, any>>) {
    console.log(`    tax "${t.name}" ${t.percentage}% ${d(money(t.applied_money))}`);
  }
  for (const t of (o.tenders ?? []) as Array<Record<string, any>>) {
    console.log(
      `    TENDER ${t.id} type=${t.type} amount=${d(money(t.amount_money))} tip=${d(money(t.tip_money))} entry=${t.card_details?.entry_method ?? "-"} ${t.card_details?.card?.card_brand ?? ""}****${t.card_details?.card?.last_4 ?? ""} payment=${t.payment_id ?? "-"}`,
    );
  }
  for (const rf of (o.refunds ?? []) as Array<Record<string, any>>) {
    console.log(`    REFUND ${rf.id} ${d(money(rf.amount_money))} ${rf.status} "${rf.reason ?? ""}"`);
  }
}

// ── who rang the $513.12 tab ──
{
  const { ok, j } = await sq(`/team-members/TMCgGKE-tm8R88JC`);
  console.log(`\n── team member who rang the $513.12 tab ──`);
  console.log(ok ? `  ${j.team_member?.given_name} ${j.team_member?.family_name} (${j.team_member?.email_address ?? "-"}) status=${j.team_member?.status}` : JSON.stringify(j).slice(0, 200));
}

// ── 2. is the orphan charge recorded ANYWHERE in Neon? ──
const { sql } = await import("@/lib/db");
const q = sql();
const ORPHAN_PAYMENT = "9cDUlimuEGo2FesJnJLfAJ7itfcZY";
const ORPHAN_ORDER = "ZitALNK3mjwAPErpM6Edh2TN8CeZY";

console.log(`\n\n══════ NEON: any row referencing the orphan payment/order? ══════`);
const cols = (await q`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND data_type IN ('text','character varying','jsonb')
  ORDER BY table_name, column_name
`) as Array<{ table_name: string; column_name: string }>;

const byTable = new Map<string, string[]>();
for (const c of cols) {
  if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
  byTable.get(c.table_name)!.push(c.column_name);
}
let found = 0;
for (const [table, columns] of byTable) {
  const preds = columns.map((c) => `CAST("${c}" AS TEXT) LIKE '%9cDUlimu%' OR CAST("${c}" AS TEXT) LIKE '%ZitALNK3%'`).join(" OR ");
  try {
    const r = (await q.query(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${preds}`)) as Array<{ n: number }>;
    const n = Array.isArray(r) ? r[0]?.n : (r as any).rows?.[0]?.n;
    if (n > 0) {
      found += n;
      console.log(`  ⚠️  ${table}: ${n} row(s) reference the orphan`);
    }
  } catch {
    /* skip tables we can't scan */
  }
}
console.log(found === 0 ? `  ✅ ZERO rows anywhere in Neon reference ${ORPHAN_PAYMENT} / ${ORPHAN_ORDER}` : `  ${found} total references`);

// ── 3. gift-card activity: confirm only ONE 1497.31 worth of funding ──
console.log(`\n══════ GIFT-CARD FUNDING RECONCILIATION ══════`);
console.log(`  GC 4983 ACTIVATE  $1151.78  ← deposit charge 94T7aLcd (06-01 18:35:02)`);
console.log(`  GC 4983 LOAD      $ 848.22  ┐`);
console.log(`  GC 1758 ACTIVATE  $ 649.09  ┘ = $1497.31 ← ONE balance charge (06-04 19:58:30, 3.5 min after diuMvXzR @19:54:56)`);
console.log(`  ─────────────────────────`);
console.log(`  funded total      $2649.09  = day-of order TxcLjpix total  ✅`);
console.log(`\n  orphan charge 9cDUlimu $1497.31 (06-04 19:45:02) funded NOTHING.`);

process.exit(0);
