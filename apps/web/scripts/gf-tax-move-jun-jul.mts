/**
 * READ-ONLY. June + July 2026 group events whose collected SALES TAX is sitting in Square's
 * SERVICE CHARGE bucket, with everything needed to reclassify it: center, event date, name,
 * BMI reservation id, event number, the Square order it is on, and the amount to move.
 *
 * The amount to move is the contract's `tax_cents` — the exact figure that was written into
 * the day-of order's `service_charges` array instead of `taxes` (see lib/gf-square-tax.ts).
 * Guests paid it; Square's tax report never saw it.
 *
 * `bmi_reservation_id` is TEXT and must never pass through Number() — 17-digit BMI ids lose
 * precision. It is only ever printed here.
 *
 *   npx tsx scripts/gf-tax-move-jun-jul.mts          # table
 *   npx tsx scripts/gf-tax-move-jun-jul.mts --csv    # CSV for the accountant
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
const CSV = process.argv.includes("--csv");
const usd = (c: number) => (c / 100).toFixed(2);
const money = (c: number) => `$${usd(c)}`;

const CENTER: Record<string, { name: string; county: string; rate: string }> = {
  "fort-myers": { name: "HeadPinz Fort Myers", county: "Lee", rate: "6.5%" },
  fasttrax: { name: "FastTrax Fort Myers", county: "Lee", rate: "6.5%" },
  naples: { name: "HeadPinz Naples", county: "Collier", rate: "6.0%" },
};

const rows = (await sql`
  select event_number, bmi_reservation_id, event_name, event_date, center_code, status,
         is_tax_exempt, tax_cents, total_cents, square_dayof_order_id, square_settled_order_id
  from group_function_quotes
  where event_date >= '2026-06-01' and event_date < '2026-08-01'
    and is_tax_exempt = false
    and tax_cents > 0
    and square_dayof_order_id is not null
    and status <> 'cancelled'
  order by center_code asc, event_date asc
`) as Array<{
  event_number: string | null;
  bmi_reservation_id: string;
  event_name: string | null;
  event_date: string;
  center_code: string;
  status: string;
  tax_cents: number;
  total_cents: number;
  square_dayof_order_id: string;
  square_settled_order_id: string | null;
}>;

const day = (v: string) => new Date(v).toISOString().slice(0, 10);
const monthOf = (v: string) => new Date(v).toISOString().slice(0, 7);

if (CSV) {
  console.log(
    "month,county,center,event_date,event_name,bmi_reservation_id,event_number,square_order_id,tax_to_move_usd,order_total_usd",
  );
  for (const r of rows) {
    const c = CENTER[r.center_code] ?? { name: r.center_code, county: "?", rate: "?" };
    const name = `"${String(r.event_name ?? "").replace(/"/g, '""')}"`;
    console.log(
      [
        monthOf(r.event_date),
        c.county,
        c.name,
        day(r.event_date),
        name,
        r.bmi_reservation_id,
        r.event_number ?? "",
        r.square_settled_order_id || r.square_dayof_order_id,
        usd(r.tax_cents),
        usd(r.total_cents),
      ].join(","),
    );
  }
} else {
  let lastKey = "";
  for (const r of rows) {
    const c = CENTER[r.center_code] ?? { name: r.center_code, county: "?", rate: "?" };
    const key = `${monthOf(r.event_date)}|${c.name}`;
    if (key !== lastKey) {
      console.log(`\n── ${monthOf(r.event_date)}  ${c.name}  (${c.county} ${c.rate}) ──`);
      console.log(
        `   ${"date".padEnd(11)}${"event".padEnd(34)}${"BMI res".padEnd(12)}${"evt#".padEnd(8)}${"move to tax".padStart(12)}`,
      );
      lastKey = key;
    }
    console.log(
      `   ${day(r.event_date).padEnd(11)}${String(r.event_name ?? "—").slice(0, 32).padEnd(34)}` +
        `${String(r.bmi_reservation_id).padEnd(12)}${String(r.event_number ?? "—").padEnd(8)}` +
        `${money(r.tax_cents).padStart(12)}`,
    );
  }
}

// ── Totals ──
const agg = new Map<string, number>();
const aggN = new Map<string, number>();
for (const r of rows) {
  const c = CENTER[r.center_code] ?? { name: r.center_code, county: "?" };
  for (const k of [
    `${monthOf(r.event_date)}`,
    `${monthOf(r.event_date)}|${c.county}`,
    `${monthOf(r.event_date)}|${c.name}`,
  ]) {
    agg.set(k, (agg.get(k) ?? 0) + r.tax_cents);
    aggN.set(k, (aggN.get(k) ?? 0) + 1);
  }
}

if (!CSV) {
  console.log(`\n${"═".repeat(72)}\nTOTAL TO MOVE FROM SERVICE CHARGE → SALES TAX\n${"═".repeat(72)}`);
  for (const month of ["2026-06", "2026-07"]) {
    console.log(`\n${month}   ${money(agg.get(month) ?? 0)}   (${aggN.get(month) ?? 0} events)`);
    for (const county of ["Lee", "Collier"]) {
      const k = `${month}|${county}`;
      if (!agg.has(k)) continue;
      console.log(`   ${county.padEnd(9)} ${money(agg.get(k)!).padStart(11)}   (${aggN.get(k)} events)`);
      for (const centerName of Object.values(CENTER)
        .filter((c) => c.county === county)
        .map((c) => c.name)) {
        const ck = `${month}|${centerName}`;
        if (!agg.has(ck)) continue;
        console.log(
          `      ${centerName.padEnd(22)} ${money(agg.get(ck)!).padStart(11)}   (${aggN.get(ck)} events)`,
        );
      }
    }
  }
  const grand = (agg.get("2026-06") ?? 0) + (agg.get("2026-07") ?? 0);
  console.log(`\nJune + July combined: ${money(grand)} across ${rows.length} events`);
}
