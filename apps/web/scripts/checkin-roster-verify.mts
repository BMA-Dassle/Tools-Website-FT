/**
 * READ-ONLY: call the REAL listBindableParty() for one or more reservations and
 * print what the kiosk would render. This is the before/after proof for the
 * W57387 roster fix — no replay, no reimplementation, the actual code path.
 * NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/checkin-roster-verify.mts <billId> [billId...]
 * (W57387 → bill 63000000007156543)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { listBindableParty } = await import("~/features/kiosk/checkin/server");

const bills = process.argv.slice(2);
if (bills.length === 0) {
  console.log("usage: npx tsx scripts/checkin-roster-verify.mts <billId> [billId...]");
  process.exit(1);
}

let anyProblem = false;
for (const billId of bills) {
  console.log(`\n══════ bill ${billId} ══════`);
  const started = Date.now();
  const { members, degraded } = await listBindableParty(billId);
  console.log(`  ${members.length} member(s)  degraded=${degraded}  (${Date.now() - started}ms)`);

  const byName = new Map<string, number>();
  for (const m of members) {
    const full = [m.firstName, m.lastName].filter(Boolean).join(" ");
    const badge = m.bmiPersonId
      ? m.waiverValid
        ? "Account & waiver ready"
        : "Waiver needed"
      : "Account + waiver needed";
    console.log(
      `    • "${full}"  id=${m.bmiPersonId ?? "NULL"}  ${badge}  [${m.source ?? "?"}]`,
    );
    const k = full.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    byName.set(k, (byName.get(k) ?? 0) + 1);
  }

  // Invariants the fix must hold.
  const dupes = [...byName.entries()].filter(([, n]) => n > 1);
  const idless = members.filter((m) => !m.bmiPersonId);
  if (dupes.length > 0) {
    anyProblem = true;
    console.log(`  ✗ DUPLICATE NAMES: ${dupes.map(([n, c]) => `${n}×${c}`).join(", ")}`);
  }
  if (idless.length > 0) {
    console.log(
      `  · ${idless.length} member(s) with no BMI person — genuinely unregistered ` +
        `(booking labels): ${idless.map((m) => m.firstName).join(", ")}`,
    );
  }
  if (degraded) {
    anyProblem = true;
    console.log(`  ✗ DEGRADED — BMI never answered; roster is booking-labels only`);
  }
  if (dupes.length === 0 && !degraded) console.log(`  ✓ one row per human, BMI-resolved`);
}
process.exit(anyProblem ? 1 : 0);
