import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import { getRecentConfirmedRaceReservationsForAssign } from "@/lib/bowling-db";
import {
  racersFromMetadata,
  assignableRacers,
  summarizeLink,
  type ScheduleResponseData,
  type AssignRacer,
} from "~/features/booking/service/race-session-assign";

/**
 * GET /api/cron/race-session-assign-sweep
 *
 * Async backstop for kiosk/web RACE session assignment. The reserve rail
 * (kiosk-post-reserve) checks racers into their Pandora race session inline;
 * when Pandora's `/bmi/schedule` endpoint 500s through the in-request retry
 * window, the racers are dropped and the reservation shows EMPTY "Assign
 * schedules" boxes in BMI, caught only by a staff memo (live 2026-07-25 —
 * W54403/04/17/25). Pandora recovers within minutes, so this cron re-drives the
 * assignment from the authoritative persisted mapping (booking_metadata.heats)
 * once it's healthy again.
 *
 * Design (mirrors deposit-retry-sweep / race-confirm-reconcile):
 *  - ONE quick POST per reservation per tick (no long in-request straggler
 *    backoffs) — retries come from the cron cadence, not from blocking the
 *    request, so one Pandora slow-patch can't blow maxDuration.
 *  - Idempotent: Pandora returns `already_linked`, so re-POSTing a healthy
 *    booking never double-links. A reservation whose racers all come back linked
 *    gets a Redis "done" flag, so a healthy booking is re-checked at most once.
 *  - Self-terminating: the candidate query is bounded to near-term heats, so a
 *    permanently-stuck row (e.g. a racer with no Pandora person — a desk job)
 *    ages out of the window instead of retrying forever.
 *
 * Kill switch: default ON (additive, idempotent). Disable with
 * `RACE_SESSION_ASSIGN_SWEEP_ENABLED=false`.
 *
 * Auth mirrors race-confirm-reconcile: scheduled runs use verifyCron; a valid
 * ?token=<ADMIN_CAMERA_TOKEN> bypasses it for manual/dev runs. ?dryRun=1 reports
 * without posting. ?force=1 ignores the Redis done-flag (re-checks everything).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const FASTTRAX_RACING_LOCATION_ID = "LAB52GY480CJF";

/** Redis "all racers on the grid" flag — a day comfortably outpaces any heat's
 *  run, and near-term-only candidacy means the key never needs to outlive it. */
const doneKey = (resNum: string) => `race-assign-done:${resNum}`;
const DONE_TTL_SEC = 60 * 60 * 24;

function sweepEnabled(): boolean {
  return process.env.RACE_SESSION_ASSIGN_SWEEP_ENABLED !== "false";
}

/** Single quick POST to /bmi/schedule (8s cap) — never throws. */
async function postScheduleOnce(
  reservationNumber: string,
  racers: AssignRacer[],
): Promise<{ ok: boolean; data: ScheduleResponseData | null; status: number }> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/schedule/${FASTTRAX_RACING_LOCATION_ID}/${reservationNumber}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ racers }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const data = (await res.json().catch(() => null)) as ScheduleResponseData | null;
    return { ok: res.ok && data?.success === true, data, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

interface SweepOutcome {
  reservationNumber: string;
  status: "linked" | "partial" | "failed" | "unassignable" | "skipped-done" | "no-racers";
  linked?: number;
  attempted?: number;
  missing?: string[];
}

// Reservations are processed by a bounded worker pool (not one big sequential
// loop): the first tick after a Pandora rough patch can face a big backlog of
// candidates, and a serial loop of 12s POSTs blew maxDuration (504, live
// 2026-07-25). A deadline stops CLAIMING new work with headroom for the last
// in-flight POST + the JSON response, so the handler always returns inside
// maxDuration; anything not reached is picked up next tick (the Redis done-flag
// means finished bookings are skipped, so the backlog drains monotonically).
// Concurrency is kept modest so a flaky Pandora isn't hammered.
const CONCURRENCY = 5;
const DEADLINE_MS = 45_000;

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }

  if (!sweepEnabled()) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const force = req.nextUrl.searchParams.get("force") === "1";
  const started = Date.now();

  const rows = await getRecentConfirmedRaceReservationsForAssign();
  const results = {
    candidates: rows.length,
    linked: 0,
    partial: 0,
    failed: 0,
    unassignable: 0,
    skippedDone: 0,
    noRacers: 0,
    wouldPost: 0,
    deferred: 0,
  };
  const outcomes: SweepOutcome[] = [];

  // Process ONE candidate: classify cheaply (Redis done-flag → racers →
  // assignable) then, when there's work, a single POST. Mutates the shared
  // counters/outcomes; safe because every ++ is synchronous between awaits (the
  // pool has no true parallelism). Never throws — the pool also guards.
  const processRow = async (row: (typeof rows)[number]): Promise<void> => {
    const resNum = row.bmiReservationNumber;
    if (!resNum) return;

    if (!force) {
      const done = await redis.get(doneKey(resNum)).catch(() => null);
      if (done) {
        results.skippedDone++;
        return; // healthy booking already confirmed on a prior tick
      }
    }

    const racers = racersFromMetadata(row.bookingMetadata);
    const assignable = assignableRacers(racers);

    if (racers.length === 0) {
      results.noRacers++;
      outcomes.push({ reservationNumber: resNum, status: "no-racers" });
      // Nothing this row can ever contribute — stop re-checking it.
      if (!dryRun) await redis.set(doneKey(resNum), "1", "EX", DONE_TTL_SEC).catch(() => {});
      return;
    }

    if (assignable.length === 0) {
      // Racers exist but none has a resolved short personId — a desk job, not a
      // sweep job (the reserve rail already memo'd them). Flag done so we don't
      // re-check every tick; staff completes them at the counter.
      results.unassignable++;
      outcomes.push({
        reservationNumber: resNum,
        status: "unassignable",
        missing: [...new Set(racers.map((r) => r.racerName))],
      });
      if (!dryRun) await redis.set(doneKey(resNum), "1", "EX", DONE_TTL_SEC).catch(() => {});
      return;
    }

    if (dryRun) {
      results.wouldPost++;
      outcomes.push({
        reservationNumber: resNum,
        status: "partial",
        attempted: assignable.length,
        missing: [...new Set(assignable.map((r) => r.racerName))],
      });
      return;
    }

    const { ok, data } = await postScheduleOnce(resNum, assignable);
    const summary = summarizeLink(assignable, ok, data);

    if (summary.complete) {
      results.linked++;
      outcomes.push({
        reservationNumber: resNum,
        status: "linked",
        linked: summary.linked,
        attempted: assignable.length,
      });
      await redis.set(doneKey(resNum), "1", "EX", DONE_TTL_SEC).catch(() => {});
      console.log(
        `[race-session-assign-sweep] ${resNum}: ${summary.linked}/${assignable.length} racers linked`,
      );
    } else {
      // Still incomplete → leave UNFLAGGED so the next tick retries once Pandora
      // is healthy. Log loudly; the reserve rail's staff memo remains the human net.
      results[ok ? "partial" : "failed"]++;
      outcomes.push({
        reservationNumber: resNum,
        status: ok ? "partial" : "failed",
        linked: summary.linked,
        attempted: assignable.length,
        missing: summary.missing,
      });
      console.error(
        `[race-session-assign-sweep] ${resNum}: INCOMPLETE ${summary.linked}/${assignable.length}` +
          ` — still not on grid: ${summary.missing.join(", ")}`,
      );
    }
  };

  // Bounded worker pool with a wall-clock deadline. Workers pull from a shared
  // cursor (synchronous ++ → each index handled once); once past the deadline
  // they stop claiming new rows, so in-flight POSTs finish and the handler
  // returns well inside maxDuration.
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (Date.now() - started < DEADLINE_MS) {
      const idx = cursor++;
      if (idx >= rows.length) return;
      try {
        await processRow(rows[idx]);
      } catch (err) {
        results.failed++;
        console.error(
          `[race-session-assign-sweep] row error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => runWorker()));

  const processed =
    results.linked +
    results.partial +
    results.failed +
    results.unassignable +
    results.skippedDone +
    results.noRacers +
    results.wouldPost;
  results.deferred = Math.max(0, rows.length - processed);

  console.log(
    `[race-session-assign-sweep] dryRun=${dryRun} candidates=${results.candidates}` +
      ` linked=${results.linked} partial=${results.partial} failed=${results.failed}` +
      ` unassignable=${results.unassignable} skippedDone=${results.skippedDone}` +
      ` deferred=${results.deferred} elapsedMs=${Date.now() - started}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    force,
    elapsedMs: Date.now() - started,
    ...results,
    outcomes,
  });
}
