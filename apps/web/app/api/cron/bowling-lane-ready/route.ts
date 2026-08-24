import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getReservation, listLanes } from "@/lib/qamf-bowling";
import { getBowlingReservationsToPollForLane } from "@/lib/bowling-db";
import { CENTER_CODE_TO_QAMF_ID } from "@/lib/qamf-centers";
import { resolveLanePhase, SELF_SERVICE_WINDOW_MINS } from "@/lib/bowling-lane-phase";
import { verifyCron } from "@/lib/cron-auth";
import {
  laneReadyKey,
  encodeLaneReady,
  LANE_READY_TTL_SECONDS,
} from "~/features/signage/lane-ready";

/**
 * GET /api/cron/bowling-lane-ready — every minute.
 *
 * WHICH RESERVATIONS COULD SELF CHECK IN RIGHT NOW, cached for the front-desk wall.
 *
 * The wall's left panel lists guests who can check themselves in, and self check-in only
 * succeeds when QAMF reports the lane ready. Working that out needs two vendor reads, and
 * a vendor read may never sit on a screen's render path — five panels polling every
 * fifteen seconds would hammer QAMF and put its latency in front of guests. So this job
 * does it once a minute and leaves the answer in Redis for the feed to read.
 *
 * Separate from `bowling-lane-poll`, which runs on the same minute cadence, ON PURPOSE.
 * That job triggers `processLaneOpen` — it fires the kitchen and charges gift cards. This
 * one is read-only and writes nothing but a Redis key, so a mistake here cannot touch
 * money. Sharing a route to save two API calls would have traded that isolation away.
 *
 * COST IS NEAR ZERO WHEN CLOSED. The Neon query returns nothing outside trading hours, so
 * on an empty result the job makes no QAMF calls at all. With guests due, it is one
 * `listLanes` per centre plus one `getReservation` per reservation in the window.
 *
 * THE PHASE RULE IS NOT DUPLICATED HERE — `resolveLanePhase` is the same function the
 * guest's own check-in route calls. A wall that invites a guest the route would then
 * refuse is worse than a wall that says nothing, and two copies of a state machine is how
 * that happens.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Both bowling centres. FastTrax has no lanes of its own here — duckpin is a different
 *  centre and is not a self-check-in surface. */
const CENTERS = ["TXBSQN0FEKQ11", "PPTR5G2N0QXF7"] as const;

interface CenterResult {
  center: string;
  due: number;
  ready: number;
  errors: number;
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const started = Date.now();
  const results: CenterResult[] = [];

  await Promise.all(
    CENTERS.map(async (centerCode) => {
      const result: CenterResult = { center: centerCode, due: 0, ready: 0, errors: 0 };
      results.push(result);

      const centerId = CENTER_CODE_TO_QAMF_ID[centerCode];
      if (!centerId) return;

      let due: Awaited<ReturnType<typeof getBowlingReservationsToPollForLane>> = [];
      try {
        due = await getBowlingReservationsToPollForLane(centerCode);
      } catch {
        result.errors++;
        return;
      }
      result.due = due.length;

      // NOTHING DUE, NOTHING ASKED. Also: do not clear the key here — let it EXPIRE. A
      // transient empty result (a Neon blip, a clock skew at a boundary) would otherwise
      // blank the wall's panel for a minute, and a slightly stale "ready" is a much
      // smaller wrong than a guest who was listed and then vanished mid-walk.
      if (due.length === 0) return;

      // ONE physical-lane read for the whole centre, shared across every reservation —
      // the per-reservation `getReservation` is what cannot be shared.
      let physicalLanes: Awaited<ReturnType<typeof listLanes>> = [];
      try {
        physicalLanes = await listLanes(centerId);
      } catch {
        result.errors++;
        // Left empty. The self-service gate then cannot open, so at worst the wall lists
        // only guests whose booked lane staff already marked Ready — quieter, never wrong.
      }

      const readyIds: string[] = [];
      await Promise.all(
        due.map(async (r) => {
          if (!r.qamfReservationId) return;
          try {
            const qamfRes = await getReservation(centerId, r.qamfReservationId);
            const resolved = resolveLanePhase({
              lanes: qamfRes.Lanes ?? [],
              physicalLanes,
              bookedAtMs: qamfRes.BookedAt ? new Date(qamfRes.BookedAt).getTime() : 0,
              nowMs: Date.now(),
            });
            if (resolved.canSelfCheckIn) {
              // The lane numbers ride along so the wall can show them BEFORE check-in —
              // "Lane 12, go ahead" is a better invitation than "you can check in".
              readyIds.push(encodeLaneReady(r.id, resolved.laneNumbers));
            }
          } catch {
            result.errors++;
            // One reservation failing must not cost the others their turn.
          }
        }),
      );

      result.ready = readyIds.length;
      try {
        // Rewritten whole each run, with a TTL well over the cadence so a single skipped
        // minute does not empty the wall.
        const key = laneReadyKey(centerCode);
        if (readyIds.length > 0) {
          await redis
            .multi()
            .del(key)
            .sadd(key, ...readyIds)
            .expire(key, LANE_READY_TTL_SECONDS)
            .exec();
        } else {
          // Nobody ready, but reservations ARE due — that is a real answer, so record it
          // rather than leaving yesterday's set to linger.
          await redis.del(key);
        }
      } catch {
        result.errors++;
      }
    }),
  );

  return NextResponse.json(
    {
      ok: true,
      windowMins: SELF_SERVICE_WINDOW_MINS,
      ms: Date.now() - started,
      centers: results,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
