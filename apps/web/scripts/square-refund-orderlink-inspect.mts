/**
 * READ-ONLY. Every one of our 1029 production refunds carries an order_id that
 * WE never set — Square assigns it. What is in that order?
 *
 * If Square auto-generates a return record (returns[] with return_line_items)
 * on a plain refund, then item-level attribution comes for free and the whole
 * itemized-vs-credit conflict dissolves: keep plain refunds (which DO credit
 * the tender) and the reporting is already correct.
 *
 *   npx tsx scripts/square-refund-orderlink-inspect.mts [days]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const DAYS = Number(process.argv[2] ?? 30);
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
  return { ok: res.ok && !(json?.errors?.length > 0), json };
}

// Exclude the last 3 days so tonight's probe refunds don't contaminate the
// sample — we want REAL production refunds, not our own test traffic.
const begin = new Date(Date.now() - DAYS * 86400_000).toISOString();
const end = new Date(Date.now() - 3 * 86400_000).toISOString();
const r = await sq(`/refunds?begin_time=${begin}&end_time=${end}&sort_order=DESC&limit=40`);
const refunds = (r.json?.refunds ?? []) as any[];
console.log(`inspecting ${refunds.length} PRODUCTION refunds (older than 3 days)\n`);

let withReturns = 0;
let partials = 0;
let shown = 0;
for (const rf of refunds) {
  if (!rf.order_id) continue;
  const o = (await sq(`/orders/${rf.order_id}`)).json?.order;
  if (!o) continue;
  const rets = o.returns ?? [];
  const rli = rets.flatMap((x: any) => x.return_line_items ?? []);
  const isPartial = (rf.amount_money?.amount ?? 0) < (o.total_money?.amount ?? 0);
  if (rli.length > 0) withReturns++;
  if (isPartial) partials++;
  if (shown < 6) {
    shown++;
    console.log(`refund ${rf.id.slice(0, 16)}… ${rf.amount_money?.amount}¢ dest=${rf.destination_type}`);
    console.log(`  linked order ${rf.order_id.slice(0, 16)}… state=${o.state} total=${o.total_money?.amount}¢`);
    console.log(`  returns[]=${rets.length} return_line_items=${rli.length}` +
      (rli.length ? ` → [${rli.map((l: any) => `${l.name ?? l.source_line_item_uid} x${l.quantity}`).join(", ")}]` : ""));
    console.log(`  return_amounts=${JSON.stringify(o.return_amounts ?? null)}`);
    console.log(`  line_items=${(o.line_items ?? []).length}`);
  }
}
console.log(
  `\nSUMMARY: ${withReturns}/${refunds.length} refund-linked orders carry return_line_items; ` +
    `${partials} of the sampled refunds were PARTIAL (amount < order total)`,
);
console.log(
  withReturns > 0
    ? "→ Square DOES record item-level returns on the refund's linked order — attribution may come for free."
    : "→ Square does NOT auto-record item-level returns; the linked order is just the source sale.",
);
