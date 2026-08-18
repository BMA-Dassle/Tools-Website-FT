/**
 * One-time remediation: put the correct tax / service-charge slots on the day-of Square
 * orders of FUTURE-DATED group events, without changing what any guest owes.
 *
 * Background in lib/gf-square-tax.ts. Those orders record $0.00 of tax because the tax
 * dollars were written into `service_charges`, and the contract service charge rode in as a
 * "Legacy Service Charge" merchandise line. reconcileDayofOrder will not fix them: it
 * no-ops when the order total already matches the contract, which it does — the total was
 * never wrong, only the slots.
 *
 * Every safety check lives in reshapeDayofOrder (lib/group-function-dayof.ts), which
 * refuses anything tendered, settled, non-OPEN, relocated, unmodellable, or whose rebuilt
 * total does not equal the live total AND the contract to the cent. This script only picks
 * the candidate set and reports.
 *
 *   npx tsx scripts/gf-reshape-future-dayof-orders.mts             # DRY RUN, writes nothing
 *   npx tsx scripts/gf-reshape-future-dayof-orders.mts --execute   # cancels + recreates
 *
 * Resumable: reshaped orders report tax, and reshapeDayofOrder skips those, so a re-run
 * only picks up what is left. Run from apps/web.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const { reshapeDayofOrder } = await import("../lib/group-function-dayof");

const sql = neon(process.env.DATABASE_URL!);
const EXECUTE = process.argv.includes("--execute");
/** Redo orders that already report tax — for when the builder itself was corrected. */
const FORCE = process.argv.includes("--force");
/** Restrict to specific event numbers: --events=H3222,3455 */
const ONLY = (process.argv.find((a) => a.startsWith("--events="))?.slice(9) ?? "")
  .split(",")
  .filter(Boolean);
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;

const all = (await sql`
  select * from group_function_quotes
  where square_dayof_order_id is not null and event_date > now()
  order by event_date asc
`) as any[];
const quotes = ONLY.length ? all.filter((q) => ONLY.includes(String(q.event_number))) : all;

console.log(
  `${EXECUTE ? "EXECUTING" : "DRY RUN (nothing will be written)"} — ` +
    `${quotes.length} future-dated events carry a day-of order\n`,
);

let reshaped = 0;
let taxRecovered = 0;
const skipped: string[] = [];

for (const q of quotes) {
  const date = String(new Date(q.event_date).toISOString()).slice(0, 10);
  const label = `${String(q.event_number).padEnd(7)} ${date} ${String(q.center_code).padEnd(11)}`;

  if (!EXECUTE) {
    console.log(`  would reshape  ${label} total ${$(q.total_cents)}  tax ${$(q.tax_cents)}`);
    continue;
  }

  const res = await reshapeDayofOrder(q, randomBytes(8).toString("hex"), { force: FORCE });
  if (res.action === "reshaped") {
    reshaped++;
    taxRecovered += res.taxCents;
    console.log(
      `  ok   ${label} ${res.oldOrderId} → ${res.newOrderId}  ` +
        `total ${$(res.totalCents)} (unchanged)  tax now ${$(res.taxCents)}`,
    );
  } else {
    skipped.push(`${label} ${res.reason}`);
    console.log(`  SKIP ${label} ${res.reason}`);
  }
}

if (EXECUTE) {
  console.log(`\n=== ${reshaped} reshaped, ${skipped.length} skipped ===`);
  console.log(`tax now visible to Square reporting: ${$(taxRecovered)}`);
  if (skipped.length) {
    console.log(`\nskipped (left exactly as they were):`);
    for (const s of skipped) console.log(`  ${s}`);
  }
} else {
  console.log(`\nDry run only. Re-run with --execute to apply.`);
}
