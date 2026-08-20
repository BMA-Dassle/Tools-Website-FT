/**
 * Drive the Groupon redeem debt forward. SERVER ONLY.
 *
 * WHY THIS EXISTS. We deliberately hand the guest their first item BEFORE
 * telling Groupon the voucher is used, because the alternative — redeem first,
 * dispense second — eats a guest's voucher when the stacker jams. The cost of
 * that choice is a window where value has moved and Groupon has not been told.
 * A `pending` row IS that debt, and this sweep is the only thing that closes
 * it. Without it the safe ordering would quietly become an unpaid obligation.
 *
 * It owns no redemption logic of its own: every row goes through
 * `redeemAfterDelivery`, which stays the single writer for a unit's redeem
 * state. Duplicating the PATCH here would create a second writer for the same
 * fact and the two would drift the first time one of them failed halfway.
 *
 * Idempotent and cheap on a quiet minute: no pending rows means one indexed
 * SELECT and zero network calls.
 */

import { countStalledRedeems, listPendingRedeems } from "../data/groupon-units-db";
import { isGrouponConfigured } from "../client.server";
import { redeemAfterDelivery } from "./resolve.server";

/** Attempts before a row is parked for a human. Matches the DB-layer default. */
const MAX_ATTEMPTS = 12;

export interface GrouponRedeemSweepResult {
  ok: boolean;
  /** Rows considered this run. */
  examined: number;
  /** Codes Groupon has now acknowledged. */
  redeemed: string[];
  /** Still owed — left `pending` on purpose, the next run retries them. */
  stillPending: string[];
  /**
   * Rows past MAX_ATTEMPTS, excluded from the worklist so they cannot starve
   * it. Never silently dropped: a non-zero count here is real money we handed
   * over and never reported, and it needs a human.
   */
  stalled: number;
  notes: string[];
}

export async function runGrouponRedeemSweep(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<GrouponRedeemSweepResult> {
  const out: GrouponRedeemSweepResult = {
    ok: true,
    examined: 0,
    redeemed: [],
    stillPending: [],
    stalled: 0,
    notes: [],
  };

  if (!isGrouponConfigured()) {
    out.notes.push("groupon not configured — nothing attempted");
    return out;
  }

  const rows = await listPendingRedeems(opts.limit ?? 25, MAX_ATTEMPTS);
  out.examined = rows.length;
  out.stalled = await countStalledRedeems(MAX_ATTEMPTS);
  if (out.stalled > 0) {
    out.notes.push(`${out.stalled} row(s) past ${MAX_ATTEMPTS} attempts — needs a human`);
  }

  if (opts.dryRun) {
    out.notes.push(`dryRun — would attempt ${rows.length}`);
    out.stillPending = rows.map((r) => r.redemptionCode);
    return out;
  }

  // Sequential on purpose. These are money-moving PATCHes against a vendor that
  // flakes under load, and the queue is tiny by construction — parallelising
  // buys nothing and makes a rate-limit storm possible.
  for (const row of rows) {
    try {
      const res = await redeemAfterDelivery(row.redemptionCode);
      if (res.redeemed) out.redeemed.push(row.redemptionCode);
      else out.stillPending.push(row.redemptionCode);
    } catch (err) {
      // One bad row must not abandon the rest of the debt.
      out.ok = false;
      out.stillPending.push(row.redemptionCode);
      out.notes.push(`${row.redemptionCode}: ${String(err).slice(0, 200)}`);
    }
  }

  return out;
}
