/**
 * READ-ONLY final reconcile for Natalie Torres / ****6235 (2026-07-28).
 *
 * Question to settle: she was charged $346.12 on the card at 17:29 (orphan,
 * qamf-confirm died on an invalid email). The 18:19 booking that DID succeed
 * (BMI W55673) was tendered as SQUARE_GIFT_CARD, and the orphan's deposit GC
 * WEBHPFM06501987 now reads $0.00. So either the orphaned deposit was reused
 * (one net charge, self-healed) or the GC was drained elsewhere (two charges).
 *
 * The gift-card ACTIVITY LEDGER decides it. Correct endpoint is
 * /v2/gift-cards/activities (not /v2/gift-card-activities).
 *
 * Also: re-sweeps ****6235 past 18:00 for any third charge, identifies the
 * ****6289 tender, and pulls the racer/party rows behind W55673. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-final.mts
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
const d = (c: any) => `$${((c ?? 0) / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
const et = (s: unknown) =>
  s ? new Date(String(s)).toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(",", "") : "-";
async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  return { ok: res.ok, j: (await res.json().catch(() => ({}))) as any };
}

// ── 1. the deposit GC ledger ──
const GC_ID = "gftc:baad1c1051224b6190c0054dfabcc67d";
console.log(`══════ GIFT CARD LEDGER — WEBHPFM06501987 (${GC_ID}) ══════`);
{
  const qs = new URLSearchParams({ gift_card_id: GC_ID, limit: "100", sort_order: "ASC" });
  const { ok, j } = await sq(`/gift-cards/activities?${qs}`);
  if (!ok) console.log(`  ${JSON.stringify(j).slice(0, 400)}`);
  else
    for (const a of (j.gift_card_activities ?? []) as any[]) {
      const det =
        a.load_activity_details ??
        a.redeem_activity_details ??
        a.activate_activity_details ??
        a.refund_activity_details ??
        a.deactivate_activity_details ??
        {};
      console.log(
        `  ${et(a.created_at)} ET  ${String(a.type).padEnd(20)} ${d(money(a.gift_card_activity_amount_money ?? det.amount_money)).padStart(10)}` +
          `  balance_after=${d(money(a.gift_card_balance_money))}  loc=${a.location_id}` +
          `\n      order=${det.order_id ?? "-"} payment=${det.payment_id ?? "-"} ref=${det.reference_id ?? "-"} status=${det.status ?? "-"}`,
      );
    }
}

// ── 2. what is ****6289? ──
console.log(`\n══════ THE ****6289 TENDER on order VAVm66wnrtx8kdXBIUboMCOudCLZY ══════`);
{
  const { ok, j } = await sq(`/orders/VAVm66wnrtx8kdXBIUboMCOudCLZY`);
  const o = j.order;
  if (!ok || !o) console.log(`  ${JSON.stringify(j).slice(0, 300)}`);
  else {
    console.log(`  state=${o.state} total=${d(money(o.total_money))} loc=${o.location_id} ref=${o.reference_id ?? "-"} created=${et(o.created_at)}`);
    for (const l of (o.line_items ?? []) as any[]) console.log(`    • ${l.quantity}× "${l.name}" ${d(money(l.total_money))}`);
    for (const t of (o.tenders ?? []) as any[])
      console.log(
        `    TENDER type=${t.type} ${d(money(t.amount_money))} pay=${t.payment_id}` +
          `\n      card=****${t.card_details?.card?.last_4 ?? "-"} brand=${t.card_details?.card?.card_brand ?? "-"} gan=${t.card_details?.card?.gan ?? "-"}`,
      );
  }
}

// ── 3. any further ****6235 card charge after 18:00 ──
console.log(`\n══════ ****6235 RE-SWEEP, 2026-07-28 18:00 ET → now (all active locations) ══════`);
{
  const { j: lj } = await sq(`/locations`);
  const locs = ((lj.locations ?? []) as any[]).filter((l) => l.status === "ACTIVE");
  let total = 0;
  for (const loc of locs) {
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({
        location_id: loc.id,
        begin_time: "2026-07-28T21:00:00Z", // 17:00 ET
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const { ok, j } = await sq(`/payments?${qs}`);
      if (!ok) break;
      for (const p of (j.payments ?? []) as any[]) {
        if (p.card_details?.card?.last_4 !== "6235") continue;
        total += p.status === "COMPLETED" ? money(p.amount_money) : 0;
        console.log(
          `  ${et(p.created_at)} ET ${p.id} ${d(money(p.amount_money))} ${p.status} src=${p.source_type} loc=${loc.name} order=${p.order_id ?? "-"} refunded=${d(money(p.refunded_money))}`,
        );
      }
      cursor = j.cursor;
    } while (cursor);
  }
  console.log(`  ⇒ NET CARD ****6235 CHARGED TODAY: ${d(total)}`);
}

// ── 4. the racers behind W55673 ──
const sql = neon(process.env.DATABASE_URL!);
console.log(`\n══════ NEON ROWS 17193 / 17194 (the good booking's legs) ══════`);
for (const t of ["bowling_reservations", "race_reservations", "reservations"]) {
  try {
    const rows = (await sql.query(`SELECT * FROM "${t}" WHERE id = ANY($1)`, [[17193, 17194]])) as any[];
    if (!rows.length) continue;
    console.log(`\n  ── ${t} ──`);
    for (const r of rows) console.log("  " + JSON.stringify(r, null, 2).split("\n").join("\n  "));
  } catch {
    /* table absent */
  }
}

console.log(`\n══════ ANY table row naming Torres / W55673 / X160990 ══════`);
{
  const cols = (await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json')
    ORDER BY table_name`) as any[];
  const byTable = new Map<string, string[]>();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
    byTable.get(c.table_name)!.push(c.column_name);
  }
  const pats = ["%W55673%", "%X160990%", "%63000000006502272%", "%natalietorres1732@gmail.com%"];
  for (const [table, columns] of byTable) {
    const where = columns.map((c) => `COALESCE("${c}"::text,'') ILIKE ANY($1)`).join(" OR ");
    try {
      const rows = (await sql.query(`SELECT * FROM "${table}" WHERE ${where} LIMIT 10`, [pats])) as any[];
      if (!rows.length) continue;
      console.log(`\n  ── ${table} (${rows.length}) ──`);
      for (const r of rows) console.log("  " + JSON.stringify(r).slice(0, 2500));
    } catch {
      /* skip */
    }
  }
}
process.exit(0);
