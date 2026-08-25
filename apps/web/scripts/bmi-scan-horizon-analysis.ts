/**
 * bmi-scan-horizon-analysis — READ-ONLY analysis, no changes.
 *
 * Question: can the group-function scan stop reading 365 days of dayPlanner
 * every run, and should the near window be swept more often than the far one?
 *
 * The scan exists to notice one thing: sales flipping a project into "Send
 * Contract". So the only number that matters is HOW FAR AHEAD OF THE EVENT that
 * flip happens. Cutting the horizon below that lead time does not save calls,
 * it strands contracts — silently, because a project outside the window is
 * indistinguishable from one that was never flipped.
 *
 * Neon answers it directly: `group_function_quotes` records `contract_sent_at`
 * and `event_date`, so every contract we have ever sent is one observation of
 * that lead time. This reports the distribution, what each candidate window
 * would have MISSED, and what each tiering option would cost per day.
 *
 *   npx tsx --env-file=../../.env.local scripts/bmi-scan-horizon-analysis.ts
 */

import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Need DATABASE_URL — use --env-file.");
  process.exit(2);
}

const sql = neon(DATABASE_URL);

/** Windows the scan could use, in days. */
const CANDIDATES = [30, 60, 90, 120, 180, 270, 365];

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${((n / of) * 100).toFixed(1)}%`;
}

async function main() {
  console.log("BMI scan horizon — how far ahead is 'Send Contract' actually flipped?\n");

  const rows = (await sql`
    SELECT
      EXTRACT(EPOCH FROM (event_date - contract_sent_at)) / 86400 AS lead_days,
      event_date,
      contract_sent_at,
      center_name,
      bmi_reservation_id
    FROM group_function_quotes
    WHERE contract_sent_at IS NOT NULL
      AND event_date IS NOT NULL
    ORDER BY lead_days DESC
  `) as Array<{
    lead_days: number;
    event_date: string;
    contract_sent_at: string;
    center_name: string | null;
    bmi_reservation_id: string | null;
  }>;

  if (!rows.length) {
    console.log("No sent contracts on record — cannot size the window from history.");
    return;
  }

  // A contract sent AFTER the event is a backfill/repair, not a lead time.
  const leads = rows.map((r) => Number(r.lead_days)).filter((d) => d >= 0);
  leads.sort((a, b) => a - b);
  const at = (p: number) => leads[Math.min(leads.length - 1, Math.floor((p / 100) * leads.length))];

  console.log(`${rows.length} contracts sent; ${leads.length} with the event still ahead of them`);
  console.log(
    `lead time (days between the send and the event):\n` +
      `   p50 ${at(50).toFixed(0)}   p90 ${at(90).toFixed(0)}   p95 ${at(95).toFixed(0)}   ` +
      `p99 ${at(99).toFixed(0)}   max ${leads[leads.length - 1].toFixed(0)}`,
  );

  console.log("\n── what each window would have MISSED ──────────────────");
  console.log("   window   missed   share    <- a miss is a contract that never sends");
  for (const days of CANDIDATES) {
    const missed = leads.filter((d) => d > days).length;
    const flag = missed === 0 ? "  SAFE" : missed / leads.length > 0.01 ? "  <-- RISK" : "";
    console.log(
      `   ${String(days).padStart(4)}d   ${String(missed).padStart(6)}   ` +
        `${pct(missed, leads.length).padStart(6)}${flag}`,
    );
  }

  // Name the worst offenders — a percentage hides whether these are real.
  const beyond90 = rows.filter((r) => Number(r.lead_days) > 90).slice(0, 8);
  if (beyond90.length) {
    console.log("\n   contracts sent more than 90 days out (a 90d window strands these):");
    for (const r of beyond90) {
      console.log(
        `     ${Number(r.lead_days).toFixed(0).padStart(4)}d  ${r.bmi_reservation_id ?? "?"}  ` +
          `${(r.center_name ?? "?").slice(0, 24)}  event ${String(r.event_date).slice(0, 10)}`,
      );
    }
  }

  // ── Cost model ──────────────────────────────────────────────────
  // The scan splits its horizon into 30-day dayPlanner windows, one call each,
  // per center. Cost is therefore windows x 2 centers x runs per day.
  console.log("\n── dayPlanner calls per day (2 centers) ────────────────");
  const runsPerDay = (everyMinutes: number) => (60 / everyMinutes) * 24;
  const cost = (horizonDays: number, everyMinutes: number) =>
    Math.ceil(horizonDays / 30) * 2 * runsPerDay(everyMinutes);

  const today = cost(365, 2);
  console.log(`   TODAY  365d every 2min                       ${today.toLocaleString()}/day`);

  const options: Array<[string, number]> = [
    ["flat 90d every 2min", cost(90, 2)],
    ["flat 180d every 2min", cost(180, 2)],
    ["TIERED 30d every 2min + 365d every 5min", cost(30, 2) + cost(365, 5)],
    ["TIERED 30d every 2min + 365d every 15min", cost(30, 2) + cost(365, 15)],
    ["TIERED 30d every 2min + 365d every 30min", cost(30, 2) + cost(365, 30)],
    ["TIERED 60d every 2min + 365d every 30min", cost(60, 2) + cost(365, 30)],
    ["TIERED 30d every 2min + 365d hourly", cost(30, 2) + cost(365, 60)],
  ];
  for (const [label, n] of options) {
    const saved = 1 - n / today;
    console.log(
      `   ${label.padEnd(42)} ${n.toLocaleString().padStart(7)}/day  ` +
        `(-${(saved * 100).toFixed(0)}%)`,
    );
  }

  console.log(
    "\nNote: the tiered options still read the FULL 365 days, just less often, so\n" +
      "nothing is stranded — the far tier only delays a far-out contract by its\n" +
      "interval, and the lead-time table above shows how much slack that has.",
  );
}

main()
  .then(() => undefined)
  .catch((e) => {
    console.error("crashed:", e);
    process.exitCode = 1;
  });
