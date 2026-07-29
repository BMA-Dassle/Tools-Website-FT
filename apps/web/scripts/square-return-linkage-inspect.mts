/**
 * READ-ONLY. When a real (POS-created) itemized refund exists, HOW is the
 * return linked back to the original sale — and does the original order show
 * the return?
 *
 * Prints, for real production refunds:
 *   - the refund's linked order
 *   - that order's returns[].source_order_id  → the original sale?
 *   - whether the return order carries its own TENDERS (the POS pattern I
 *     suspect: return + refund tender created as ONE order, rather than a
 *     return order stitched to a separate RefundPayment call)
 *   - what the ORIGINAL order looks like afterwards
 *
 *   npx tsx scripts/square-return-linkage-inspect.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
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

// Production window only — skip tonight's probe traffic.
const begin = new Date(Date.now() - 60 * 86400_000).toISOString();
const end = new Date(Date.now() - 3 * 86400_000).toISOString();
const r = await sq(`/refunds?begin_time=${begin}&end_time=${end}&sort_order=DESC&limit=60`);
const refunds = (r.json?.refunds ?? []) as any[];

let shown = 0;
for (const rf of refunds) {
  if (!rf.order_id || shown >= 4) continue;
  const ret = (await sq(`/orders/${rf.order_id}`)).json?.order;
  const rli = (ret?.returns ?? []).flatMap((x: any) => x.return_line_items ?? []);
  // Only the genuinely itemized ones (named lines), not amount-only shapes.
  if (!rli.some((l: any) => l.name)) continue;
  shown++;

  const srcId = ret?.returns?.[0]?.source_order_id;
  console.log(`\n═══ refund ${rf.id.slice(0, 20)}… ${rf.amount_money?.amount}¢ dest=${rf.destination_type}`);
  console.log(`  RETURN order ${ret.id}`);
  console.log(`    state=${ret.state} line_items=${(ret.line_items ?? []).length} tenders=${(ret.tenders ?? []).length}`);
  console.log(`    returns[0].source_order_id = ${srcId ?? "(none)"}`);
  console.log(`    return_line_items: ${rli.map((l: any) => `${l.name ?? "?"} x${l.quantity} (src uid ${l.source_line_item_uid ?? "none"})`).join(" | ")}`);
  if ((ret.tenders ?? []).length) {
    console.log(
      `    TENDERS ON THE RETURN ORDER: ${ret.tenders.map((t: any) => `${t.type} ${t.amount_money?.amount}¢ payment=${t.payment_id ?? "none"}`).join(" | ")}`,
    );
  }
  console.log(`    return_amounts.total=${ret.return_amounts?.total_money?.amount}¢`);

  if (srcId) {
    const src = (await sq(`/orders/${srcId}`)).json?.order;
    if (src) {
      console.log(`  ORIGINAL order ${src.id}`);
      console.log(`    state=${src.state} total=${src.total_money?.amount}¢ line_items=${(src.line_items ?? []).length} tenders=${(src.tenders ?? []).length}`);
      console.log(`    does the ORIGINAL carry returns[]? ${(src.returns ?? []).length > 0 ? "YES" : "no"}`);
      console.log(`    original tender types: ${(src.tenders ?? []).map((t: any) => t.type).join(", ") || "none"}`);
    } else {
      console.log(`  ORIGINAL order ${srcId} — not readable`);
    }
  }
}
if (shown === 0) console.log("no itemized production refunds found in the window");
