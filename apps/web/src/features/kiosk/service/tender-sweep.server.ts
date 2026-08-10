/**
 * Kiosk tender sweep — the server-side observer the auth-then-capture rail
 * was missing (the "terminal-orphan reconcile" five code comments promised).
 * Every ambient arm writes a kiosk_split_tenders row, so the ledger's stale
 * OPEN rows are a complete work list of sessions whose kiosk browser stopped
 * driving the loop: walk-aways with live holds, crashes between capture and
 * finalize, anchors Redis lost.
 *
 * Per stale row (45+ min without a touch — every guest action bumps it):
 *   captured/COMPLETED  → forward-RECORD (state captured, full payment set to
 *                         Neon) + alert: money moved but finalize never ran —
 *                         fulfillment is rail-specific, so v1 alerts ops
 *                         rather than auto-finalizing.
 *   holds cover total   → forward-CAPTURE via captureSplit (idempotent, own
 *                         lock) + the same alert. A guest who paid then
 *                         walked is NEVER silently voided (owner decision).
 *   partial/zero holds  → unwind via abandonSplit (harvest-dismiss + verified
 *                         cancels + honest cancel-failed recording).
 *   anchor gone (TTL)   → operate from the ledger row + Square: record a
 *                         COMPLETED order as captured; void the row's
 *                         authorized tender payments otherwise. An armed
 *                         checkout id lives only on the anchor, so a lost
 *                         anchor's reader checkout times out on Square's side.
 *
 * Outcomes needing human eyes surface via the ledger states (needs_review /
 * captured) and the run log — no Teams alerting (removed 2026-08-10, owner
 * decommissioned the call-center chat feed). Square's 36h auto-CANCEL of
 * uncaptured auths remains the last backstop.
 */
import {
  readTerminalAnchor,
  type TerminalAnchor,
} from "~/features/booking/service/unified-reserve";
import { getOrderPaymentInfo } from "./square-terminal";
import {
  abandonSplit,
  captureSplit,
  harvestAndDismissPending,
  splitRemainingCents,
  verifiedCancel,
} from "./split-tenders";
import {
  listStaleOpenSplitAttempts,
  setSplitCaptured,
  setSplitState,
  type SplitAttemptRow,
} from "../data/split-tenders-db";

/** Rows older than this with no liveness touch are abandoned. Every guest
 *  action (arm, poll, add, remove) bumps updated_at — an active session can
 *  never look this stale. */
const STALE_MINUTES = 45;

export interface SweepOutcome {
  baseKey: string;
  seed: string;
  action:
    | "captured-not-finalized" // money moved; finalize never ran — needs eyes
    | "forward-captured" // holds covered the total; sweep captured them
    | "canceled" // holds voided, session closed
    | "needs-review" // a void failed / over-collected — human eyes
    | "skipped-locked"; // a live capture/abandon held the lock — next run
  detail?: string;
}

export interface SweepResult {
  ok: true;
  scanned: number;
  outcomes: SweepOutcome[];
  dryRun: boolean;
}

async function sweepOne(row: SplitAttemptRow, dryRun: boolean): Promise<SweepOutcome> {
  const { baseKey, seed } = row;
  const anchor = await readTerminalAnchor(seed);

  // ── Anchor gone (48h TTL or Redis loss): the ledger row + Square are the
  //    whole truth. ─────────────────────────────────────────────────────────
  if (!anchor) {
    const orderId = row.depositOrderId;
    const info = orderId ? await getOrderPaymentInfo(orderId).catch(() => null) : null;
    if (info?.state === "COMPLETED") {
      if (!dryRun) {
        await setSplitCaptured(baseKey, {
          tenders: row.tenders,
          paymentIds: info.paymentIds,
          capturedAt: new Date().toISOString(),
        });
      }
      return {
        baseKey,
        seed,
        action: "captured-not-finalized",
        detail: `order ${orderId} COMPLETED, anchor lost — verify fulfillment`,
      };
    }
    // Void whatever the ledger recorded as authorized; the payments are the
    // only handles left. Unrecorded taps expire on Square's 36h backstop.
    let anyFailed = false;
    for (const t of row.tenders) {
      if (t.status !== "authorized" || !t.paymentId) continue;
      if (dryRun) continue;
      const outcome = await verifiedCancel(baseKey, t.paymentId);
      if (outcome !== "canceled") anyFailed = true;
    }
    if (!dryRun) await setSplitState(baseKey, anyFailed ? "needs_review" : "canceled");
    return anyFailed
      ? { baseKey, seed, action: "needs-review", detail: "anchor lost; a void did not stick" }
      : { baseKey, seed, action: "canceled", detail: "anchor lost; ledger holds voided" };
  }

  // ── Anchor present: reuse the rail's own machinery. ──────────────────────
  if (anchor.capturedAt) {
    if (!dryRun) {
      await setSplitCaptured(baseKey, {
        tenders: (anchor.tenders ?? []) as SplitAttemptRow["tenders"],
        paymentIds: anchor.paymentIds ?? [],
        capturedAt: anchor.capturedAt,
      });
    }
    return {
      baseKey,
      seed,
      action: "captured-not-finalized",
      detail: "captured but the ledger row stayed open — finalize likely never ran",
    };
  }
  const order = await getOrderPaymentInfo(anchor.depositOrderId).catch(() => null);
  if (order?.state === "COMPLETED") {
    if (!dryRun) {
      await setSplitCaptured(baseKey, {
        tenders: (anchor.tenders ?? []) as SplitAttemptRow["tenders"],
        paymentIds: order.paymentIds,
        capturedAt: new Date().toISOString(),
      });
    }
    return {
      baseKey,
      seed,
      action: "captured-not-finalized",
      detail: `order ${anchor.depositOrderId} COMPLETED — verify fulfillment`,
    };
  }

  if (dryRun) {
    // Classification only — harvest/dismiss mutate Square state.
    const remaining = splitRemainingCents(anchor);
    const holds = (anchor.tenders ?? []).filter((t) => t.status === "authorized").length;
    return remaining <= 0 && holds > 0
      ? { baseKey, seed, action: "forward-captured", detail: "(dry run) holds cover the total" }
      : { baseKey, seed, action: "canceled", detail: `(dry run) would void ${holds} hold(s)` };
  }

  // Harvest first: an unpolled tap must count before the cover/void decision.
  const fresh = await harvestAndDismissPending(seed, anchor);
  const remaining = splitRemainingCents(fresh);
  const holds = (fresh.tenders ?? []).filter((t) => t.status === "authorized").length;
  const splitToken = fresh.splitToken ?? "";

  if (remaining <= 0 && holds > 0) {
    // The guest PAID, then walked — capture and hand ops the decision
    // (fulfill or refund); never silently void committed money.
    const cap = await captureSplit({ seed, splitToken });
    if (cap.ok) {
      return {
        baseKey,
        seed,
        action: "forward-captured",
        detail: `captured ${cap.paymentIds.length} payment(s) — booking was never finalized; fulfill or refund`,
      };
    }
    if (cap.error === "busy") return { baseKey, seed, action: "skipped-locked" };
    await setSplitState(baseKey, "needs_review");
    return { baseKey, seed, action: "needs-review", detail: `capture failed: ${cap.error}` };
  }

  const ab = await abandonSplit({ seed, splitToken });
  if (!ab.ok && ab.error === "busy") return { baseKey, seed, action: "skipped-locked" };
  if (!ab.ok && ab.error === "already-captured") {
    return {
      baseKey,
      seed,
      action: "captured-not-finalized",
      detail: "a capture raced the sweep — verify fulfillment",
    };
  }
  // abandonSplit records cancel-failed → needs_review itself; report what the
  // ledger now says.
  return { baseKey, seed, action: "canceled" };
}

export async function runKioskTenderSweep(opts: { dryRun?: boolean } = {}): Promise<SweepResult> {
  const dryRun = opts.dryRun === true;
  const rows = await listStaleOpenSplitAttempts(STALE_MINUTES);
  const outcomes: SweepOutcome[] = [];
  for (const row of rows) {
    try {
      outcomes.push(await sweepOne(row, dryRun));
    } catch (err) {
      console.error(`[kiosk-tender-sweep] row ${row.baseKey} threw:`, err);
      if (!dryRun) await setSplitState(row.baseKey, "needs_review").catch(() => {});
      outcomes.push({
        baseKey: row.baseKey,
        seed: row.seed,
        action: "needs-review",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (outcomes.length) {
    console.log(
      `[kiosk-tender-sweep] scanned=${rows.length} ${outcomes
        .map((o) => `${o.action}:${o.baseKey.slice(0, 8)}`)
        .join(" ")}${dryRun ? " (dry run)" : ""}`,
    );
  }
  return { ok: true, scanned: rows.length, outcomes, dryRun };
}
