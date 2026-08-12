import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import {
  listDueSyncRows,
  listParkedSyncRows,
  markSyncDone,
  markSyncRetry,
  syncQueueCounts,
  type SyncQueueRow,
} from "@/lib/bmi-sync-queue";
import {
  personLocalBarrier,
  personCloudBarrier,
  projectLocalBarrier,
  type BarrierResult,
} from "@/lib/bmi-sync-barriers";
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

/** Which barrier a row wants, resolved to a probe. Rows whose barrier needs a
 *  ref it does not have are treated as unbarriered rather than stuck forever. */
async function probeBarrier(row: SyncQueueRow): Promise<BarrierResult> {
  const ref = row.barrierRef;
  switch (row.barrier) {
    case "none":
      return { verdict: "open", detail: "no barrier" };
    case "person-local":
      if (!ref) return { verdict: "open", detail: "no barrierRef — treating as unbarriered" };
      return personLocalBarrier(row.locationId || "LAB52GY480CJF", ref);
    case "person-cloud":
      if (!ref) return { verdict: "open", detail: "no barrierRef — treating as unbarriered" };
      return personCloudBarrier(ref, (row.payload.clientKey as string) || undefined);
    case "project-local":
      if (!ref) return { verdict: "open", detail: "no barrierRef — treating as unbarriered" };
      return projectLocalBarrier(row.locationId || "LAB52GY480CJF", ref);
    default:
      // Unknown barrier value (a row written by a newer deploy, say). Do NOT run
      // the handler blind — that is the whole class of bug this exists to stop.
      return { verdict: "error", detail: `unknown barrier "${row.barrier}"` };
  }
}

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
    deferred: 0,
  };
  const outcomes: Outcome[] = [];

  for (const row of rows) {
    if (Date.now() - started > DEADLINE_MS) {
      counts.deferred++;
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
        const state = await markSyncRetry(row, `barrier error: ${barrier.detail}`);
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
  const summary = await syncQueueCounts();

  console.log(
    `[bmi-sync-queue] dryRun=${dryRun} due=${counts.due} ran=${counts.ran} done=${counts.done} ` +
      `waiting=${counts.waiting} retry=${counts.retry} parked=${counts.parked} ` +
      `deferred=${counts.deferred} parkedTotal=${parked.length} elapsedMs=${Date.now() - started}`,
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
    summary,
    outcomes,
  });
}
