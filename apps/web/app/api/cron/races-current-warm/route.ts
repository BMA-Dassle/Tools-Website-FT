import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import { refreshRacesCurrent } from "~/features/racing/races-current.server";

/**
 * THE SESSION-STATUS WARM LOOP — what makes "called" state ~realtime
 * (owner 2026-08-14: "we need as close to realtime for session status as
 * possible. 1 second is the minimums").
 *
 * Vercel crons can't fire faster than once a minute, so this one fires every
 * minute and LOOPS for ~52 seconds, refreshing the Redis carry about once a
 * second. Every board reads that carry (cacheOnly), so the estate sees a
 * called heat within roughly: Pandora latency + 1s loop step + the board's
 * own 1-2s poll — a few seconds end to end, down from the old ~40-90s ladder.
 *
 * One loop at a time: an NX claim (50s TTL) makes an overlapping invocation
 * exit immediately rather than double the Pandora rate. A failed refresh
 * counts and continues — Pandora is believed fixed (2026-08-14), and if it
 * regresses the boards ride the carry, merely staler.
 *
 * The every-minute checkin-alerts cron still does its own default-mode read
 * for alerting; this loop exists purely to keep the display carry hot.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LOOP_BUDGET_MS = 52_000;
const STEP_MS = 1_000;
/** Per-fetch ceiling — generous for a healthy Pandora, small enough that one
 *  bad request can't eat half the loop's minute. */
const FETCH_TIMEOUT_MS = 8_000;

const CLAIM_KEY = "races-current:warm-loop";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const claimed = await redis.set(CLAIM_KEY, String(Date.now()), "EX", 50, "NX").catch(() => null);
  if (claimed !== "OK") {
    return NextResponse.json({ ok: true, skipped: "another warm loop is running" });
  }

  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;
  try {
    while (Date.now() - startedAt < LOOP_BUDGET_MS) {
      try {
        await refreshRacesCurrent(FETCH_TIMEOUT_MS);
        refreshed++;
      } catch {
        failed++;
      }
      await sleep(STEP_MS);
    }
  } finally {
    // Release early so the next minute's invocation never waits out the TTL.
    await redis.del(CLAIM_KEY).catch(() => void 0);
  }

  return NextResponse.json({ ok: true, refreshed, failed, ranMs: Date.now() - startedAt });
}
