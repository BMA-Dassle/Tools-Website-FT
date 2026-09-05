import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import {
  listDueSyncRows,
  listParkedSyncRows,
  listStuckSyncRows,
  markSyncDone,
  markSyncRetry,
  lapseSyncRow,
  parkSyncRow,
  syncQueueCounts,
} from "@/lib/bmi-sync-queue";
import { probeBarrier } from "@/lib/bmi-sync-probe";
import { lapseVerdict } from "@/lib/bmi-sync-lapse";
import { SYNC_HANDLERS } from "@/lib/bmi-sync-handlers";

/**
 * GET /api/cron/bmi-sync-queue — every 2 minutes.
 *
 * The waiter. Under the owner's cloud-first rule ("cloud is first, onsite
 * second") the guest-critical chain completes entirely on the BMI CLOUD, and
 * every LOCAL (Pandora) followup becomes a queue row that fires only once its
 * barrier confirms the other side can see the entity. This cron is the thing
 * that checks barriers and runs handlers.
 *
 * ORDER OF OPERATIONS PER ROW — the important part:
 *   1. barrier probe (reads only)
 *   2. closed  → reschedule WITHOUT burning an attempt (waiting on Fast WSync is
 *                not a failed attempt; the give-up DEADLINE is what bounds it)
 *      error   → reschedule and burn an attempt (we could not even ask)
 *      open    → run the handler
 *   3. handler verdict → done / retry / park
 *
 * Parked rows are reported on EVERY run, including an otherwise-idle one, so
 * "gave up" can never read as "all clear" (the lesson from the swallowed
 * $2,113.95 — a silent give-up looks exactly like success in a log).
 *
 * Kill switch `BMI_SYNC_QUEUE=false`. Auth mirrors the other sweeps: scheduled
 * runs use verifyCron, `?token=<ADMIN_CAMERA_TOKEN>` bypasses for manual runs,
 * `?dryRun=1` probes barriers and reports what WOULD run without writing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEADLINE_MS = 45_000;
const BATCH = 100;

function enabled(): boolean {
  return process.env.BMI_SYNC_QUEUE !== "false";
}

/**
 * The barrier probe now lives in `@/lib/bmi-sync-probe` so this cron and the Vercel
 * Queues consumer (`/api/queue/bmi-sync`) ask the SAME question. Two copies drifted
 * once already — a preview wrote a `persons-local` row that production did not
 * recognise, and it burned 20 attempts reporting "unknown barrier".
 */

interface Outcome {
  id: number;
  kind: string;
  barrier: string;
  verdict: string;
  result: string;
  detail?: string;
}

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }
  if (!enabled()) return NextResponse.json({ ok: true, disabled: true });

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const started = Date.now();
  const rows = await listDueSyncRows(BATCH);
  const counts = {
    due: rows.length,
    ran: 0,
    done: 0,
    waiting: 0,
    retry: 0,
    parked: 0,
    /** Rows written off because their moment passed — never an alarm. */
    lapsed: 0,
    deferred: 0,
  };
  const outcomes: Outcome[] = [];

  for (const row of rows) {
    if (Date.now() - started > DEADLINE_MS) {
      counts.deferred++;
      continue;
    }
    /**
     * HAS THE MOMENT PASSED? Checked BEFORE the barrier, because a row whose
     * window has closed should not cost another vendor round trip to find out —
     * and because the answer does not depend on what the barrier would say.
     */
    const lapse = lapseVerdict(row);
    if (lapse) {
      counts.lapsed++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "lapsed",
        result: dryRun ? "would-lapse" : "lapsed",
        detail: lapse,
      });
      if (!dryRun) await lapseSyncRow(row, lapse);
      continue;
    }

    const barrier = await probeBarrier(row);

    if (barrier.verdict === "closed") {
      counts.waiting++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "closed",
        result: dryRun ? "would-wait" : "waiting",
        detail: barrier.detail,
      });
      // Waiting is NOT an attempt — see the header.
      if (!dryRun)
        await markSyncRetry(row, `barrier closed: ${barrier.detail}`, { countAttempt: false });
      continue;
    }

    // The barrier can NEVER open (e.g. the person lives at another center).
    // Park immediately: sitting closed until the give-up deadline reports
    // "not synced yet" for hours about something that is not a sync problem.
    if (barrier.verdict === "impossible") {
      counts.parked++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "impossible",
        result: dryRun ? "would-park" : "parked",
        detail: barrier.detail,
      });
      if (!dryRun) await parkSyncRow(row, barrier.detail);
      continue;
    }

    if (barrier.verdict === "error") {
      counts.retry++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "error",
        result: dryRun ? "would-retry" : "retry",
        detail: barrier.detail,
      });
      if (!dryRun) {
        // Same split as the queue consumer: a vendor we could not reach tells
        // us nothing about this row, so it must not spend the row's patience.
        // The cron is the BACKSTOP rail — if it burns attempts during an outage
        // the row is parked here even when the queue rail behaved.
        const state = await markSyncRetry(row, `barrier error: ${barrier.detail}`, {
          countAttempt: barrier.unreachable !== true,
        });
        if (state === "parked") counts.parked++;
      }
      continue;
    }

    // Barrier open — the other side can see it.
    if (dryRun) {
      counts.ran++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "open",
        result: "would-run",
        detail: barrier.detail,
      });
      continue;
    }

    const handler = SYNC_HANDLERS[row.kind];
    if (!handler) {
      // Unknown kind: park rather than retry forever on something no deploy can run.
      counts.parked++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "open",
        result: "unknown-kind",
      });
      await markSyncRetry({ ...row, attempts: 9_999 }, `no handler for kind "${row.kind}"`);
      continue;
    }

    counts.ran++;
    let res;
    try {
      res = await handler(row);
    } catch (err) {
      // Handlers are contracted not to throw; if one does, retry is the safe read.
      res = {
        ok: false,
        retry: true,
        detail: err instanceof Error ? err.message.slice(0, 200) : "threw",
      };
    }

    if (res.ok) {
      counts.done++;
      await markSyncDone(row.id, res.detail);
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "open",
        result: "done",
        detail: res.detail,
      });
    } else if (res.retry === false) {
      counts.parked++;
      await markSyncRetry({ ...row, attempts: 9_999 }, res.detail);
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "open",
        result: "terminal",
        detail: res.detail,
      });
    } else {
      counts.retry++;
      const state = await markSyncRetry(row, res.detail);
      if (state === "parked") counts.parked++;
      outcomes.push({
        id: row.id,
        kind: row.kind,
        barrier: row.barrier,
        verdict: "open",
        result: state,
        detail: res.detail,
      });
    }
  }

  // ALWAYS report parked rows — including on an idle run.
  const parked = await listParkedSyncRows(25);
  /**
   * ...and rows that are still TRYING but have been trying too long.
   *
   * Parked-row reporting exists so a give-up can never read as success. It stopped
   * being sufficient on 2026-09-05, when `push-waiver-signature` and
   * `add-membership` became kinds that never give up: they can now be owed
   * indefinitely without ever becoming parked, so "parkedTotal=0" no longer means
   * "nothing needs a human". The only thing that caught a queue problem that day
   * was the owner reading the board by eye.
   */
  const stuck = await listStuckSyncRows(25);
  const summary = await syncQueueCounts();

  console.log(
    `[bmi-sync-queue] dryRun=${dryRun} due=${counts.due} ran=${counts.ran} done=${counts.done} ` +
      `waiting=${counts.waiting} retry=${counts.retry} parked=${counts.parked} ` +
      `deferred=${counts.deferred} parkedTotal=${parked.length} stuckTotal=${stuck.length} ` +
      `elapsedMs=${Date.now() - started}`,
  );
  if (parked.length > 0) {
    console.error(
      `[bmi-sync-queue] PARKED (needs a human): ` +
        parked
          .slice(0, 10)
          .map((p) => `#${p.id} ${p.kind} ref=${p.barrierRef ?? "-"} — ${p.lastError ?? "?"}`)
          .join(" | "),
    );
  }
  if (stuck.length > 0) {
    // Age is the whole point of this line — "still pending" is not news, "still
    // pending after four hours" is — so lead with it.
    console.error(
      `[bmi-sync-queue] STUCK (still trying, well past normal): ` +
        stuck
          .slice(0, 10)
          .map(
            (s) =>
              `#${s.id} ${s.kind} ${Math.round((Date.now() - Date.parse(s.createdAt)) / 60_000)}m ` +
              `barrier=${s.barrier} ref=${s.barrierRef ?? "-"} — ${s.lastError ?? "?"}`,
          )
          .join(" | "),
    );
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    elapsedMs: Date.now() - started,
    ...counts,
    parked: parked.map((p) => ({
      id: p.id,
      kind: p.kind,
      barrierRef: p.barrierRef,
      attempts: p.attempts,
      lastError: p.lastError,
    })),
    stuck: stuck.map((s) => ({
      id: s.id,
      kind: s.kind,
      barrier: s.barrier,
      barrierRef: s.barrierRef,
      ageMin: Math.round((Date.now() - Date.parse(s.createdAt)) / 60_000),
      attempts: s.attempts,
      lastError: s.lastError,
    })),
    summary,
    outcomes,
  });
}
