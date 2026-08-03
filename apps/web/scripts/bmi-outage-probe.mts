/** READ-ONLY: is BMI back? + what did our side touch during the outage window.
 *  Usage: npx tsx scripts/bmi-outage-probe.mts [hoursBack=12]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const HOURS = Number(process.argv[2] || 12);
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const { fetchProject } = await import("@/lib/bmi-office-actions");
const q = sql();

// ── 1. Is BMI reachable right now? Probe each center with a known-good project.
console.log(`── BMI health probe ──`);
const probes = (await q`
  SELECT DISTINCT ON (center_code) center_code, bmi_reservation_id, event_number
  FROM group_function_quotes
  WHERE bmi_reservation_id IS NOT NULL
  ORDER BY center_code, id DESC
`) as Array<Record<string, any>>;
for (const p of probes) {
  const t0 = Date.now();
  try {
    const proj = await fetchProject(p.center_code, String(p.bmi_reservation_id));
    console.log(
      `  ${p.center_code.padEnd(12)} ${proj ? "UP" : "NULL-RESPONSE"} (${Date.now() - t0}ms) proj=${p.bmi_reservation_id}`,
    );
  } catch (err) {
    console.log(
      `  ${p.center_code.padEnd(12)} DOWN (${Date.now() - t0}ms) — ${err instanceof Error ? err.message.slice(0, 120) : err}`,
    );
  }
}

// ── 2. GF quotes touched during the window
console.log(`\n── group_function_quotes updated in last ${HOURS}h ──`);
const gf = (await q`
  SELECT id, event_number, event_name, center_code, status, bmi_reservation_id,
         total_cents, collected_cents, balance_cents, deposit_due_cents,
         event_date, created_at, updated_at
  FROM group_function_quotes
  WHERE updated_at >= NOW() - (${HOURS} * INTERVAL '1 hour')
  ORDER BY updated_at DESC
`) as Array<Record<string, any>>;
console.log(`  ${gf.length} rows`);
for (const r of gf) {
  console.log(
    `  #${r.id} ${r.event_number} ${String(r.event_name).slice(0, 28).padEnd(28)} ${r.center_code.padEnd(11)} ${String(r.status).padEnd(16)} total=${d(r.total_cents)} coll=${d(r.collected_cents)} proj=${r.bmi_reservation_id ?? "NONE"} upd=${String(r.updated_at).slice(0, 24)}`,
  );
}

// ── 3. Deposit-retry queue depth (the one path that DOES have a retry queue)
console.log(`\n── bmi_deposit_failures created in last ${HOURS}h ──`);
try {
  const df = (await q`
    SELECT id, source, source_ref, person_id, amount, attempts, last_error, created_at, resolved_at
    FROM bmi_deposit_failures
    WHERE created_at >= NOW() - (${HOURS} * INTERVAL '1 hour')
    ORDER BY created_at DESC
  `) as Array<Record<string, any>>;
  console.log(`  ${df.length} rows (${df.filter((r) => !r.resolved_at).length} unresolved)`);
  for (const r of df)
    console.log(
      `  #${r.id} ${String(r.source).padEnd(22)} ref=${String(r.source_ref).slice(0, 24).padEnd(24)} person=${r.person_id} amt=${r.amount} att=${r.attempts} ${r.resolved_at ? "RESOLVED" : "OPEN"} ${String(r.last_error ?? "").slice(0, 60)}`,
    );
} catch (e) {
  console.log(`  table read failed: ${e instanceof Error ? e.message : e}`);
}

process.exit(0);
