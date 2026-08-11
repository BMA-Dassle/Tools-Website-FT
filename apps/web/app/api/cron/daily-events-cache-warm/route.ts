import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import redis from "@/lib/redis";
import { LOCATIONS } from "~/features/daily-events/constants";
import { todayET } from "~/features/daily-events/format";
import {
  dailyEventsCacheKey,
  listDailyEventsUncached,
  DAILY_EVENTS_CACHE_TTL_SECONDS,
} from "~/features/daily-events/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Cache warmer for the daily-events board (owner 2026-07-13: "the loading
 * just sucks"). Every 5 minutes, pre-fetches BMI reservations for
 * today−1 … today+13 at all three locations into the SAME Redis keys the
 * reservations route serves (`de:res:{loc}:{date}:0`, 6-min TTL). With the
 * cache warm, the board's BMI phase is a ~0.1s hit and the whole board
 * paints once — the "loading legacy events" wait only exists for dates
 * outside this window.
 *
 * ?days=N overrides the horizon (max 31). Failures are per-cell and
 * non-fatal — a missed cell just falls back to a live fetch on the board.
 */

// TTL is owned by the daily-events service — the key, the body shape and the
// lifetime are one contract shared with the board, the kiosk rail and the TV.
const TTL_SECONDS = DAILY_EVENTS_CACHE_TTL_SECONDS;
const CONCURRENCY = 6;

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const horizon = Math.min(parseInt(req.nextUrl.searchParams.get("days") || "13", 10) || 13, 31);
  const today = todayET();
  const dates: string[] = [];
  for (let i = -1; i <= horizon; i++) dates.push(shiftDate(today, i));

  const cells: Array<{ locationId: number; date: string }> = [];
  for (const loc of LOCATIONS) for (const date of dates) cells.push({ locationId: loc.id, date });

  let warmed = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < cells.length; i += CONCURRENCY) {
    await Promise.all(
      cells.slice(i, i + CONCURRENCY).map(async ({ locationId, date }) => {
        try {
          // UNCACHED on purpose — this cron is the writer. Calling the cached
          // `listDailyEvents` would make it read its own key and re-warm a
          // stale copy forever, and the board would never see a new booking.
          const data = await listDailyEventsUncached(locationId, date, false);
          const body = JSON.stringify({ success: true, data });
          await redis.setex(dailyEventsCacheKey(locationId, date), TTL_SECONDS, body);
          warmed++;
        } catch (err) {
          failed++;
          console.warn(
            `[de-cache-warm] ${locationId}/${date} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    warmed,
    failed,
    cells: cells.length,
    tookMs: Date.now() - startedAt,
  });
}
