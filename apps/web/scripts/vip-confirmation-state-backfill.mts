/**
 * Backfill: move existing Ultimate VIP Experience reservations onto the BMI
 * "Confirmation - VIP" custom state (55466363 @ headpinzftmyers).
 *
 * SCOPE (owner 2026-08-02): UPCOMING reservations only — Neon
 * `status = 'confirmed'`, i.e. booked and not yet run. Completed past events are
 * deliberately left in whatever state they finished in (no historical rewrite),
 * and CANCELLED rows are never touched at all.
 *
 * SAFETY
 *  - Read-then-compare per row (`stampVipState`): only claims -3, the
 *    pending-online ladder, or a kiosk confirmation id. A -4 Cancellation or a
 *    -5 Arrived row is reported "left-alone", never overwritten — a blind write
 *    would revive a cancel or un-check-in a guest at the counter.
 *  - Idempotent: a second run reports every row "already".
 *  - Verifies by READBACK after each write; a write that reports success but
 *    doesn't stick is reported as drifted, not as done.
 *  - Dry-run by DEFAULT. Pass --commit to write.
 *
 * Run from apps/web:
 *   npx tsx scripts/vip-confirmation-state-backfill.mts            # dry run
 *   npx tsx scripts/vip-confirmation-state-backfill.mts --commit    # write
 *   npx tsx scripts/vip-confirmation-state-backfill.mts --all       # incl. completed
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */

const COMMIT = process.argv.includes("--commit");
const INCLUDE_COMPLETED = process.argv.includes("--all");

const { officeProjectIdFromBillId, fetchProject, VIP_CONFIRMATION_STATE_IDS } = await import(
  "@/lib/bmi-office-actions"
);
const { stampVipState } = await import("~/features/combos/vip-state.server");
const { sql } = await import("@/lib/db");

const VIP_STATE_ID = VIP_CONFIRMATION_STATE_IDS["fasttrax"];
const STATE_NAMES: Record<string, string> = {
  "-3": "Confirmation",
  "-4": "Cancellation",
  "-5": "Temporary/Arrived",
  "-100": "Pending online",
  "-101": "Payment started",
  "-102": "Paid online",
  "3274635": "Confirmation + Waiver",
  "55397028": "Confirmation - Kiosk",
  "55466363": "Confirmation - VIP",
};
const name = (id: string | null) => (id ? (STATE_NAMES[id] ?? id) : "?");

const q = sql();

// The BMI-bearing leg of a VIP combo is the RACE row — the bowling leg is a QAMF
// reservation with no BMI project. `cancelled` is excluded in SQL, not just in
// the per-row guard, so a cancelled row is never even addressed.
const statuses = INCLUDE_COMPLETED ? ["confirmed", "completed"] : ["confirmed"];
const rows = (await q`
  SELECT id, combo_special_id, guest_name, status, bmi_bill_id, bmi_reservation_number
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND product_kind = 'race'
    AND bmi_bill_id IS NOT NULL
    AND status = ANY(${statuses})
  ORDER BY id
`) as Array<Record<string, any>>;

console.log(
  `${COMMIT ? "COMMIT" : "DRY RUN"} — Confirmation - VIP (${VIP_STATE_ID}) backfill\n` +
    `scope: status IN (${statuses.join(", ")}) → ${rows.length} race legs\n`,
);

const tally = { stamped: 0, already: 0, leftAlone: 0, failed: 0, skipped: 0, drifted: 0 };

for (const r of rows) {
  const billId = String(r.bmi_bill_id);
  const projectId = officeProjectIdFromBillId(billId);
  const tag =
    `#${String(r.id).padEnd(6)} ${String(r.bmi_reservation_number ?? "?").padEnd(8)} ` +
    `${String(r.combo_special_id).padEnd(13)} ${String(r.guest_name ?? "").slice(0, 22).padEnd(22)}`;

  if (!COMMIT) {
    // Dry run: report the live state and what WOULD happen, using the same
    // read the stamp does — never a guess from the Neon status.
    const project = await fetchProject("fasttrax", projectId);
    const current = project?.stateId != null ? String(project.stateId) : null;
    const verdict =
      current === VIP_STATE_ID
        ? "already VIP"
        : current === "-3" || current === "55397028" || /^-10[012]$/.test(current ?? "")
          ? "WOULD STAMP"
          : "would leave alone";
    console.log(`${tag} state=${String(current).padEnd(9)} ${name(current).padEnd(21)} ${verdict}`);
    if (verdict === "WOULD STAMP") tally.stamped++;
    else if (verdict === "already VIP") tally.already++;
    else tally.leftAlone++;
    continue;
  }

  // Historical/upcoming rows have no `-3` write in flight, so no self-heal
  // window is needed — one read-then-compare write, then verify by readback.
  const result = await stampVipState({
    centerCode: "fasttrax",
    officeProjectId: projectId,
    label: "Confirmation - VIP (backfill)",
    ensureAttempts: 0,
  });

  if (result.outcome === "stamped") {
    const after = await fetchProject("fasttrax", projectId);
    const now = after?.stateId != null ? String(after.stateId) : null;
    if (now === VIP_STATE_ID) {
      tally.stamped++;
      console.log(`${tag} ${name(result.from)} → Confirmation - VIP  ✓ verified`);
    } else {
      tally.drifted++;
      console.log(`${tag} ${name(result.from)} → PUT ok but readback=${name(now)}  ✗ DRIFTED`);
    }
  } else if (result.outcome === "already") {
    tally.already++;
    console.log(`${tag} already Confirmation - VIP`);
  } else if (result.outcome === "left-alone") {
    tally.leftAlone++;
    console.log(`${tag} state=${name(result.state)} — not ours, left alone`);
  } else if (result.outcome === "skipped") {
    tally.skipped++;
    console.log(`${tag} skipped: ${result.reason}`);
  } else {
    tally.failed++;
    console.log(`${tag} FAILED: ${result.error}`);
  }
}

console.log(
  `\n=== ${COMMIT ? "COMMIT" : "DRY RUN"} summary ===\n` +
    `  stamped     ${tally.stamped}\n` +
    `  already VIP ${tally.already}\n` +
    `  left alone  ${tally.leftAlone}\n` +
    `  drifted     ${tally.drifted}\n` +
    `  skipped     ${tally.skipped}\n` +
    `  failed      ${tally.failed}`,
);
if (!COMMIT) console.log("\nNo writes performed. Re-run with --commit to apply.");
process.exit(tally.failed > 0 || tally.drifted > 0 ? 1 : 0);
