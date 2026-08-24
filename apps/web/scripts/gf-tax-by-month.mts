/**
 * READ-ONLY. Tax per month, for the accountant conversation.
 *
 * Two separate figures, and they mean different things:
 *   COLLECTED-BUT-INVISIBLE — tax the guest paid, recorded in Square's service-charge slot,
 *     so `total_tax_money` read $0 and it never appeared in a Square tax report. If the
 *     DR-15 was prepared from Square's tax report, these periods were UNDER-REPORTED even
 *     though the money was taken.
 *   NEVER BILLED — tax never charged to the guest at all. Florida sales tax is owed on the
 *     sale whether or not it was collected, so this is a liability, not just lost margin.
 *
 * Grouped by EVENT month (when the sale is recognised) and by COUNTY, because Lee and
 * Collier are separate returns:
 *   HeadPinz Fort Myers + FastTrax Fort Myers → Lee 6.5%
 *   HeadPinz Naples                           → Collier 6.0%
 *
 * Run from apps/web. NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const money = (c: number) => (c === 0 ? "—" : `$${(c / 100).toFixed(2)}`);
const pad = (s: string, n: number) => s.padStart(n);

const COUNTY: Record<string, string> = {
  "fort-myers": "Lee",
  fasttrax: "Lee",
  naples: "Collier",
};

const rows = (await sql`
  select event_number, event_date, center_code, status, is_tax_exempt,
         tax_cents, total_cents, line_items, square_dayof_order_id
  from group_function_quotes
  where line_items is not null
  order by event_date asc
`) as any[];

type Cell = {
  invisible: number;
  unbilled: number;
  nInv: number;
  nUnb: number;
  /** Split on the EVENT DATE, not the month, so a part-elapsed month reports honestly. */
  invisibleOccurred: number;
  unbilledOccurred: number;
};
const grid = new Map<string, Map<string, Cell>>(); // month -> county -> cell
const cell = (month: string, county: string) => {
  const byCounty = grid.get(month) ?? new Map<string, Cell>();
  grid.set(month, byCounty);
  const c =
    byCounty.get(county) ??
    ({
      invisible: 0,
      unbilled: 0,
      nInv: 0,
      nUnb: 0,
      invisibleOccurred: 0,
      unbilledOccurred: 0,
    } as Cell);
  byCounty.set(county, c);
  return c;
};

const now = Date.now();
for (const r of rows) {
  if (String(r.status) === "cancelled") continue; // no sale, nothing owed
  const items = (r.line_items as any[]).filter((i) => i && i.total);
  if (!items.length) continue;
  const county = COUNTY[r.center_code] ?? r.center_code;
  const month = new Date(r.event_date).toISOString().slice(0, 7);
  const c = cell(month, county);
  const occurred = new Date(r.event_date).getTime() < now;

  // Collected but invisible: a non-exempt event whose tax rode in the service-charge slot.
  // Every day-of order created before today's fix was built that way.
  if (!r.is_tax_exempt && r.tax_cents > 0 && r.square_dayof_order_id) {
    c.invisible += r.tax_cents;
    if (occurred) c.invisibleOccurred += r.tax_cents;
    c.nInv++;
  }

  // Never billed: the contract charged less tax than its own line items imply.
  if (!r.is_tax_exempt) {
    const implied = Math.round(items.reduce((s, i) => s + (i.tax || 0) * (i.total || 0), 0) * 100);
    const short = implied - r.tax_cents;
    if (short > 2) {
      c.unbilled += short;
      if (occurred) c.unbilledOccurred += short;
      c.nUnb++;
    }
  }
}

const counties = ["Lee", "Collier"];
console.log(
  "\nTAX PER MONTH — by EVENT month. 'Invisible' = collected but not in Square's tax report.\n" +
    "'Unbilled' = never charged to the guest (still owed to FL). Cancelled events excluded.\n",
);
console.log(
  `${pad("month", 8)} │ ${pad("Lee invisible", 15)} ${pad("Lee unbilled", 14)} │ ${pad("Collier inv.", 14)} ${pad("Collier unb.", 13)} │ ${pad("MONTH TOTAL", 13)}`,
);
console.log("─".repeat(96));

const blank = (): Cell => ({
  invisible: 0,
  unbilled: 0,
  nInv: 0,
  nUnb: 0,
  invisibleOccurred: 0,
  unbilledOccurred: 0,
});
const totals: Record<string, Cell> = { Lee: blank(), Collier: blank() };
let pastInv = 0;
let futureInv = 0;

for (const month of [...grid.keys()].sort()) {
  const byCounty = grid.get(month)!;
  const get = (c: string) => byCounty.get(c) ?? blank();
  const lee = get("Lee");
  const col = get("Collier");
  for (const c of counties) {
    const v = get(c);
    totals[c].invisible += v.invisible;
    totals[c].unbilled += v.unbilled;
    totals[c].nInv += v.nInv;
    totals[c].nUnb += v.nUnb;
    totals[c].invisibleOccurred += v.invisibleOccurred;
    totals[c].unbilledOccurred += v.unbilledOccurred;
  }
  pastInv += lee.invisibleOccurred + col.invisibleOccurred;
  futureInv += lee.invisible + col.invisible - lee.invisibleOccurred - col.invisibleOccurred;
  const upcoming =
    lee.invisible + col.invisible - lee.invisibleOccurred - col.invisibleOccurred > 0;

  const rowTotal = lee.invisible + lee.unbilled + col.invisible + col.unbilled;
  console.log(
    `${pad(month, 8)} │ ${pad(money(lee.invisible), 15)} ${pad(money(lee.unbilled), 14)} │ ` +
      `${pad(money(col.invisible), 14)} ${pad(money(col.unbilled), 13)} │ ${pad(money(rowTotal), 13)}` +
      `${upcoming ? `   incl. ${money(lee.invisible + col.invisible - lee.invisibleOccurred - col.invisibleOccurred)} on events NOT YET HELD (now corrected)` : ""}`,
  );
}

console.log("─".repeat(96));
console.log(
  `${pad("TOTAL", 8)} │ ${pad(money(totals.Lee.invisible), 15)} ${pad(money(totals.Lee.unbilled), 14)} │ ` +
    `${pad(money(totals.Collier.invisible), 14)} ${pad(money(totals.Collier.unbilled), 13)} │ ` +
    `${pad(money(totals.Lee.invisible + totals.Lee.unbilled + totals.Collier.invisible + totals.Collier.unbilled), 13)}`,
);
console.log(
  `\n  Lee     : ${money(totals.Lee.invisible)} invisible across ${totals.Lee.nInv} events, ` +
    `${money(totals.Lee.unbilled)} unbilled across ${totals.Lee.nUnb}`,
);
console.log(
  `  Collier : ${money(totals.Collier.invisible)} invisible across ${totals.Collier.nInv} events, ` +
    `${money(totals.Collier.unbilled)} unbilled across ${totals.Collier.nUnb}`,
);
console.log(
  `\n  Of the invisible tax: ${money(pastInv)} is on events that ALREADY HAPPENED (periods that may` +
    ` be filed),\n  ${money(futureInv)} is on future events and is now recorded correctly.`,
);
