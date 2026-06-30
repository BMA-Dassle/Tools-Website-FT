/** READ-ONLY: dump version history + audit log + key timestamps for a quote id. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const QID = Number(process.argv[2] ?? "150");
const { sql } = await import("@/lib/db");
const q = sql();

const base = (await q`SELECT contract_signed_at, deposit_paid_at, contract_sent_at, created_at, updated_at,
  total_cents, deposit_due_cents, balance_cents, collected_cents, tax_cents, status
  FROM group_function_quotes WHERE id = ${QID}`) as Array<Record<string, unknown>>;
console.log("══ TIMESTAMPS / MONEY ══");
console.log(JSON.stringify(base[0], null, 2));

const versions = (await q`SELECT version_number, trigger, changes, snapshot, created_at
  FROM contract_versions WHERE quote_id = ${QID} ORDER BY version_number ASC`) as Array<Record<string, unknown>>;
console.log(`\n══ CONTRACT VERSIONS (${versions.length}) ══`);
for (const v of versions) {
  const snap = v.snapshot as Record<string, unknown>;
  console.log(`\n--- v${v.version_number}  trigger=${v.trigger}  at=${v.created_at}`);
  console.log(`   total=$${((snap.total_cents as number) / 100).toFixed(2)} dep=$${((snap.deposit_due_cents as number) / 100).toFixed(2)} bal=$${((snap.balance_cents as number) / 100).toFixed(2)} tax=$${((snap.tax_cents as number) / 100).toFixed(2)}`);
  const items = (snap.line_items ?? []) as Array<Record<string, unknown>>;
  for (const li of items) console.log(`     • ${li.qty}× "${li.name}" $${li.price} (plu=${li.plu})`);
  if (Array.isArray(v.changes) && (v.changes as unknown[]).length) console.log(`   changes: ${JSON.stringify(v.changes)}`);
}

const audit = (await q`SELECT event, actor_email, metadata, created_at
  FROM contract_audit_log WHERE quote_id = ${QID} ORDER BY created_at ASC`) as Array<Record<string, unknown>>;
console.log(`\n══ AUDIT LOG (${audit.length}) ══`);
for (const a of audit) {
  console.log(`  ${a.created_at}  ${a.event}  by=${a.actor_email ?? "-"}  ${JSON.stringify(a.metadata)}`);
}
process.exit(0);
