/** Verify: original order total (tax-incl) vs split new-order totals vs gift card balance. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const SQB = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();

const ORDERS = [
  "ta8ExW2mU4spvqKtBcdDlkkAiQ6YY",
  "t4TWwoDi4eGylTMu9E44he4XNAbZY",
  "bhooMRGfEhqtJi9oPZsrb4sQVbGZY",
  "vRrKnIKBrUamE1dvZTPWib954SIZY",
];

function isWeekend(ymd: string): boolean {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() : 0;
  return day === 0 || day === 5 || day === 6;
}

for (const id of ORDERS) {
  const oRes = await fetch(`${SQB}/orders/${id}`, { headers: H });
  const o = (await oRes.json()).order as {
    total_money?: { amount?: number };
    net_amount_due_money?: { amount?: number };
    line_items?: Array<{ name?: string; quantity?: string; catalog_object_id?: string; base_price_money?: { amount?: number } }>;
  };
  const UQ = "X4RZPTPJEJ45OG3S3HMDMCHZ";
  const comboLine = (o.line_items ?? []).find(
    (li) => /VIP Experience|Race \+ Bowl/i.test(li.name ?? "") || (li.catalog_object_id === UQ && [6500, 7500].includes(li.base_price_money?.amount ?? 0)),
  );
  const ppl = Number(comboLine?.quantity ?? 0) || 0;

  const rows = (await q`
    SELECT product_kind, booked_at, square_gift_card_id, square_gift_card_gan
    FROM bowling_reservations WHERE square_dayof_order_id = ${id}
  `) as Array<Record<string, unknown>>;
  const ymd = rows[0]?.booked_at ? new Date(rows[0].booked_at as string).toISOString().slice(0, 10) : "";
  const we = isWeekend(ymd);
  const gcId = (rows[0]?.square_gift_card_id ?? "") as string;
  const gan = (rows[0]?.square_gift_card_gan ?? "") as string;

  // split new-order totals WITH 6.5% tax
  const ftPre = ppl * 4399;
  const hpPre = ppl * (we ? 3101 : 2101);
  const ftTot = Math.round(ftPre * 1.065);
  const hpTot = Math.round(hpPre * 1.065);

  // gift card balance
  let gcBal = -1;
  if (gcId) {
    const gRes = await fetch(`${SQB}/gift-cards/${gcId}`, { headers: H });
    const g = await gRes.json();
    gcBal = g.gift_card?.balance_money?.amount ?? -1;
  }

  console.log(`\n${id}  ${ppl}p ${we ? "we" : "wd"}  gan=${gan}`);
  console.log(`  original order total (tax-incl): $${((o.total_money?.amount ?? 0) / 100).toFixed(2)}  net_due: $${((o.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)}`);
  console.log(`  split FastTrax tax-incl: $${(ftTot / 100).toFixed(2)}  + HeadPinz tax-incl: $${(hpTot / 100).toFixed(2)}  = $${((ftTot + hpTot) / 100).toFixed(2)}`);
  console.log(`  gift card balance:               $${(gcBal / 100).toFixed(2)}  ${gcBal === ftTot + hpTot ? "✓ MATCH" : gcBal === (o.total_money?.amount ?? 0) ? "(= original order)" : "‼ MISMATCH"}`);
}
