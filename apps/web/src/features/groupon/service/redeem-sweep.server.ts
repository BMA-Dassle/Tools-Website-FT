/**
 * Drive the Groupon redeem debt forward. SERVER ONLY.
 *
 * WHY THIS EXISTS. The redeem PATCH fires at SCAN, inline (owner 2026-08-20),
 * so in the normal case there is nothing here to do. This sweep is the retry
 * net for the abnormal case: Groupon flaked, the request timed out, or the
 * process died between writing the ledger row and getting an acknowledgement.
 * A `pending` row is a voucher we have already converted into our own tables
 * and honoured, but never told Groupon about — a bookkeeping debt, not a guest
 * problem. Nothing here can affect what a guest is owed.
 *
 * It owns no redemption logic of its own: every row goes through
 * `redeemGrouponUnit`, which stays the single writer for a unit's redeem
 * state. Duplicating the PATCH here would create a second writer for the same
 * fact and the two would drift the first time one of them failed halfway.
 *
 * Idempotent and cheap on a quiet minute: no pending rows means one indexed
 * SELECT and zero network calls.
 *
 */

import { countStalledRedeems, listPendingRedeems } from "../data/groupon-units-db";
import { isGrouponConfigured } from "../client.server";
import { redeemGrouponUnit } from "./resolve.server";

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
      const res = await redeemGrouponUnit(row.redemptionCode);
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
