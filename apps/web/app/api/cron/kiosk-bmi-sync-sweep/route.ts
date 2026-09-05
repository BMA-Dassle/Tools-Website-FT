import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import {
  kioskBmiSyncSweepEnabled,
  kioskCheckinAttachEnabled,
  kioskWaiverBmiAttachEnabled,
} from "~/features/kiosk/flags";
import { runCheckinScheduleSweep } from "~/features/kiosk/checkin/schedule-sweep";
import { listRecentFailedJoins } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { reattachJoinRows } from "~/features/kiosk/waiver/attach-backfill";

/**
 * GET /api/cron/kiosk-bmi-sync-sweep — every 2 minutes.
 *
 * The patience the kiosk rails were missing. Both kiosk launches write across
 * the BMI rail boundary (cloud attach ↔ local Pandora seat) and used to treat
 * Fast WSync's minutes-long propagation as a terminal failure:
 *
 *  PHASE 1 — check-in seats. completeCheckin now makes ONE fast schedule
 *  attempt and records sync-lagged racers 'waiting-sync'; this sweep re-drives
 *  them until Pandora's local server has the project-person row (Pandora's own
 *  per-racer answer is the probe), memos staff once at 10 min, gives up at 60.
 *  Ends the hand-seat → duplicate T_PROJECT_PERSON → WSync-jam chain
 *  (2026-08-11 incident).
 *
 *  PHASE 2 — waiver-join attaches. Recent 'failed' kiosk_waiver_joins rows
 *  (last 48h, older than 30 min so a fresh in-flight attach is never raced)
 *  re-attach via the shared reattachJoinRows brain: live-roster reconcile
 *  first (never re-POST someone BMI already has), person must be visible on
 *  the Office cloud (barrier A), then the corrected orderId attach. The
 *  historical backlog stays the manual /api/admin/waiver-attach-backfill
 *  route's job — this phase only keeps NEW failures from going stale.
 *
 * Design mirrors race-session-assign-sweep: one quick pass per tick, retries
 * come from the cron cadence (never from blocking sleeps), idempotent vendor
 * calls, deadline with headroom so the handler always returns inside
 * maxDuration. Kill switch KIOSK_BMI_SYNC_SWEEP=false; the BMI writes also
 * respect the per-rail KIOSK_CHECKIN_BMI_ATTACH / KIOSK_WAIVER_BMI_ATTACH
 * switches. Auth: scheduled runs use verifyCron; ?token=<ADMIN_CAMERA_TOKEN>
 * bypasses for manual/dev runs; ?dryRun=1 reports without writing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEADLINE_MS = 45_000;
const WAIVER_MIN_AGE_MINUTES = 30;
const WAIVER_MAX_AGE_HOURS = 48;
const WAIVER_LIMIT_PER_TICK = 40;

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }

  if (!kioskBmiSyncSweepEnabled()) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const started = Date.now();
  const deadlineAtMs = started + DEADLINE_MS;

  // ── Phase 1: check-in 'waiting-sync' seats ─────────────────────────────────
  let checkin: Awaited<ReturnType<typeof runCheckinScheduleSweep>> | { disabled: true } = {
    disabled: true,
  };
  if (kioskCheckinAttachEnabled()) {
    checkin = await runCheckinScheduleSweep({ dryRun, deadlineAtMs });
  }

  // ── Phase 2: recent waiver-join attach failures ────────────────────────────
  let waiver:
    | { candidates: number; counts: Record<string, number> }
    | { disabled: true }
    | { skipped: "deadline" } = { disabled: true };
  if (kioskWaiverBmiAttachEnabled()) {
    if (Date.now() > deadlineAtMs) {
      waiver = { skipped: "deadline" };
    } else {
      const candidates = await listRecentFailedJoins({
        minAgeMinutes: WAIVER_MIN_AGE_MINUTES,
        maxAgeHours: WAIVER_MAX_AGE_HOURS,
        limit: WAIVER_LIMIT_PER_TICK,
      });
      const { counts } = await reattachJoinRows(candidates, {
        dryRun,
        requirePersonVisible: true,
        deadlineAtMs,
      });
      waiver = { candidates: candidates.length, counts };
    }
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[kiosk-bmi-sync-sweep] dryRun=${dryRun} elapsedMs=${elapsedMs} ` +
      `checkin=${JSON.stringify("disabled" in checkin ? checkin : { rows: checkin.rows, seated: checkin.seated, waiting: checkin.stillWaiting + checkin.waitingPersonSync, terminal: checkin.terminal })} ` +
      `waiver=${JSON.stringify(waiver)}`,
  );

  /**
   * PER-ROW DETAIL, not just the tally.
   *
   * The summary above says how many rows are waiting; it has never said WHICH, or
   * why, or whether their heat has even happened yet. That gap is what turned
   * 2026-09-05 into eight ad-hoc probe scripts to answer a question the sweep knew
   * the answer to on every tick: the row was twenty minutes early.
   *
   * Only the rows that did NOT seat are logged, so a clean tick stays one line and
   * the noisy ticks are the ones worth reading. `where` is the heat position, which
   * is the difference between "not late yet" and "should have happened".
   */
  if ("outcomes" in checkin && Array.isArray(checkin.outcomes)) {
    const unresolved = checkin.outcomes.filter(
      (o) => o.outcome !== "seated" && o.outcome !== "already-linked",
    );
    if (unresolved.length > 0) {
      console.log(
        `[kiosk-bmi-sync-sweep] unseated (${unresolved.length}): ` +
          unresolved
            .slice(0, 20)
            .map(
              (o) =>
                `${o.billId}/${o.person} ${o.outcome}` +
                `${o.where ? ` [${o.where}]` : ""}${o.detail ? ` — ${o.detail}` : ""}`,
            )
            .join(" | "),
      );
    }
  }

  return NextResponse.json({ ok: true, dryRun, elapsedMs, checkin, waiver });
}
