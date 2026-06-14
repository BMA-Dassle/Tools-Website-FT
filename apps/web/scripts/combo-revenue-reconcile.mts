/**
 * READ-ONLY reconciliation report for the 7 existing single-order combo
 * bookings. For each, compute the FastTrax racing revenue (that belongs at
 * FastTrax FM but booked at HeadPinz FM) vs the HeadPinz bowling revenue,
 * using the locked split: FastTrax $43.99/person (races+POV+license),
 * HeadPinz $21.01 wd / $31.01 we per person (VIP bowling + shoes). Tier from
 * the Neon reservation's booked_at. No writes.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const { sql } = await import("@/lib/db");
const q = sql();

const ORDERS = [
  "ta8ExW2mU4spvqKtBcdDlkkAiQ6YY",
  "t4TWwoDi4eGylTMu9E44he4XNAbZY",
  "bhooMRGfEhqtJi9oPZsrb4sQVbGZY",
  "jLRbsTuQkqLmK9kun44U4ydfwRQZY",
  "9u6QxALDQenCoqQmg4ywXOhmXacZY",
  "pAgMBo9DRiJNPIMA4Q9JvYFOkxAZY",
  "vRrKnIKBrUamE1dvZTPWib954SIZY",
];

const FT_PP = 4399; // races + POV + license
const HP_PP_WD = 2101; // VIP bowling 1601 + shoes 500
const HP_PP_WE = 3101; // VIP bowling 2601 + shoes 500

function isWeekend(ymd: string): boolean {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() : 0;
  return day === 0 || day === 5 || day === 6; // Fri/Sat/Sun (Tue mega = weekday)
}

let ftTotal = 0;
let hpTotal = 0;
console.log("order                          ppl  tier  tendered  date        FastTrax→  HeadPinz(stays)");
for (const id of ORDERS) {
  const res = await fetch(`https://connect.squareup.com/v2/orders/${id}`, { headers: H });
  const data = (await res.json()) as {
    order?: {
      line_items?: Array<{ name?: string; quantity?: string }>;
      tenders?: unknown[];
      total_money?: { amount?: number };
    };
  };
  const o = data.order as
    | {
        line_items?: Array<{
          name?: string;
          quantity?: string;
          catalog_object_id?: string;
          base_price_money?: { amount?: number };
        }>;
        tenders?: unknown[];
      }
    | undefined;
  const UQ = "X4RZPTPJEJ45OG3S3HMDMCHZ";
  const comboLine = (o?.line_items ?? []).find(
    (li) =>
      /VIP Experience|Race \+ Bowl/i.test(li.name ?? "") ||
      (li.catalog_object_id === UQ && [6500, 7500].includes(li.base_price_money?.amount ?? 0)),
  );
  const ppl = Number(comboLine?.quantity ?? 0) || 0;
  const tendered = (o?.tenders?.length ?? 0) > 0;

  const rows = (await q`
    SELECT booked_at FROM bowling_reservations WHERE square_dayof_order_id = ${id} LIMIT 1
  `) as Array<{ booked_at: unknown }>;
  const rawBooked = rows[0]?.booked_at;
  const ymd = rawBooked ? new Date(rawBooked as string).toISOString().slice(0, 10) : "";
  const weekend = ymd ? isWeekend(ymd) : false;

  const ftCents = ppl * FT_PP;
  const hpCents = ppl * (weekend ? HP_PP_WE : HP_PP_WD);
  ftTotal += ftCents;
  hpTotal += hpCents;
  console.log(
    `${id}  ${String(ppl).padStart(2)}  ${(weekend ? "we" : "wd").padEnd(4)}  ${(tendered ? "PAID" : "open").padEnd(7)}  ${(ymd || "?").padEnd(10)}  $${(ftCents / 100).toFixed(2).padStart(8)}  $${(hpCents / 100).toFixed(2)}`,
  );
}
console.log("\n── Totals (pre-tax revenue) ──");
console.log(`FastTrax FM owed (move from HeadPinz): $${(ftTotal / 100).toFixed(2)}`);
console.log(`HeadPinz FM keeps:                     $${(hpTotal / 100).toFixed(2)}`);
