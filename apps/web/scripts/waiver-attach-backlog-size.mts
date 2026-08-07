/**
 * READ-ONLY: how big is the "signed at home but never reached BMI" backlog?
 * Sizes kiosk_waiver_joins by bmi_attach_status, and flags the two buckets the
 * admin backfill route structurally CANNOT see (pending / skipped). NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/waiver-attach-backlog-size.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { sql } = await import("@/lib/db");
const q = sql();

console.log("══════ kiosk_waiver_joins by attach status ══════");
const rows = (await q`
  SELECT bmi_attach_status AS st, count(*)::int AS n,
         min(created_at) AS oldest, max(created_at) AS newest
  FROM kiosk_waiver_joins GROUP BY 1 ORDER BY 2 DESC
`) as Array<Record<string, any>>;
for (const r of rows) {
  const blind = r.st === "pending" || r.st === "skipped" ? "  ← BACKFILL CANNOT SEE" : "";
  console.log(
    `  ${String(r.st).padEnd(10)} ${String(r.n).padStart(5)}   ${String(r.oldest).slice(0, 10)} → ${String(r.newest).slice(0, 10)}${blind}`,
  );
}

const tot = (await q`
  SELECT count(*)::int AS n, count(DISTINCT project_id)::int AS projects
  FROM kiosk_waiver_joins
`) as Array<Record<string, any>>;
console.log(`  TOTAL ${tot[0].n} rows across ${tot[0].projects} reservations`);

console.log("\n══════ error text on failed rows (top 10) ══════");
const errs = (await q`
  SELECT bmi_attach_error AS e, count(*)::int AS n
  FROM kiosk_waiver_joins
  WHERE bmi_attach_error IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`) as Array<Record<string, any>>;
if (errs.length === 0) console.log("  (none)");
for (const r of errs) console.log(`  ${String(r.n).padStart(4)} × ${String(r.e).slice(0, 120)}`);

console.log("\n══════ how much is still in the FUTURE (worth fixing first) ══════");
const upcoming = (await q`
  SELECT j.bmi_attach_status AS st, count(*)::int AS n
  FROM kiosk_waiver_joins j
  WHERE j.bmi_attach_status <> 'attached'
  GROUP BY 1 ORDER BY 2 DESC
`) as Array<Record<string, any>>;
for (const r of upcoming) console.log(`  not-attached ${String(r.st).padEnd(10)} ${r.n}`);

console.log("\n══════ race bookings whose heats carry NO personId (RC8 scale) ══════");
const nullHeats = (await q`
  SELECT count(*)::int AS reservations,
         sum(CASE WHEN h.e->>'bmiPersonId' IS NULL THEN 1 ELSE 0 END)::int AS null_racers,
         count(h.e)::int AS total_racers
  FROM bowling_reservations r,
       LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(r.booking_metadata::jsonb->'heats')='array'
              THEN r.booking_metadata::jsonb->'heats' ELSE '[]'::jsonb END) AS h(e)
  WHERE r.product_kind = 'race' AND r.status = 'confirmed'
    AND r.created_at > now() - interval '90 days'
`) as Array<Record<string, any>>;
console.log(
  `  last 90d confirmed race heats: ${nullHeats[0].total_racers} racer rows, ` +
    `${nullHeats[0].null_racers} with NULL bmiPersonId ` +
    `(${nullHeats[0].total_racers ? Math.round((nullHeats[0].null_racers / nullHeats[0].total_racers) * 100) : 0}%)`,
);
process.exit(0);
