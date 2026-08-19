import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import { venueCalledFastPathEnabled } from "~/features/racing/venue-called.server";
import { refreshRacesCurrent, type TrackKey } from "~/features/racing/races-current.server";
import { warmSessionRoster } from "~/features/racing/session-roster.server";

/**
 * THE SESSION-STATUS WARM LOOP — now the NET under the venue WebSocket, not the
 * source of the called heat.
 *
 * Owner 2026-08-14 asked for "as close to realtime for session status as possible,
 * 1 second is the minimums", and this loop delivered it the only way available at
 * the time: Vercel crons cannot fire faster than once a minute, so it fires every
 * minute and loops for ~52 seconds. Every board reads the Redis carry
 * (`cacheOnly`), so the estate saw a called heat within a few seconds instead of
 * the old ~40-90s ladder.
 *
 * As of 2026-08-19 the venue's own broadcast writes that carry too
 * (`venue-called.server.ts`), and it is both cheaper and usually earlier — so the
 * step relaxes to 30s while the bridge is alive, and snaps back to 1s the moment
 * it is not. The realtime promise is kept by a push instead of a poll; see
 * `warmLoopStepMs` below for the whole rule and the measurements behind it.
 *
 * One loop at a time: an NX claim (50s TTL) makes an overlapping invocation exit
 * immediately rather than double the Pandora rate. A failed refresh counts and
 * continues.
 *
 * The every-minute checkin-alerts cron still does its own default-mode read for
 * alerting; this loop exists purely to keep the display carry hot.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LOOP_BUDGET_MS = 52_000;

/**
 * THE STEP IS NOW A DECISION, NOT A CONSTANT (2026-08-19).
 *
 * This loop existed to learn one thing — which heat is called — by asking Pandora
 * about once a second, all day: ~2,200 calls an hour, ~53,000 a day, over half of
 * everything we send that vendor. The venue's own WebSocket pushes the same fact,
 * and as of this change `venue-called.server.ts` writes it into the carry through
 * the shared seam. Measured over 91 heats: the venue's frame reaches us a median
 * 4.8s BEFORE our poll recorded the call, and on the degraded evening of 8/18 our
 * record of Mega 60 was thirteen minutes late while the venue had it on time.
 *
 * So the poll stops being the source and becomes the NET, at 30s: it still catches
 * a call that produced no venue event, still reconciles anything the wire got
 * wrong, and still owns the between-heats carry. ~2,200/hr → ~120/hr.
 *
 * EXCEPT WHEN THE BRIDGE IS DEAD, which is not hypothetical: on 8/17 15:07-15:19
 * the ingest buffer holds zero frames of any kind and four called heats went
 * unseen by the wire. A half-open socket looks exactly like a quiet venue from in
 * here, so silence is not evidence of calm — if the bridge's heartbeat is stale
 * this loop goes straight back to 1s stepping and carries the estate alone.
 */
const STEP_FAST_MS = 1_000;
const STEP_RELAXED_MS = 30_000;
/** Beyond this, the bridge is not feeding us and the poll takes over. The venue
 *  sends BcTime every ~30s even on a dead-quiet night, so 2 min is ~4 missed
 *  heartbeats — long enough not to flap, short enough to cover one heat. */
const BRIDGE_STALE_MS = 120_000;

/**
 * How fast should this minute's loop step? PURE, so the decision is testable
 * without a clock or a socket.
 *
 * Fast (1s) when the fast path is switched off, when the bridge has not been
 * heard from inside `BRIDGE_STALE_MS`, or when there is no heartbeat at all —
 * every one of those means nothing else is writing the carry.
 */
export function warmLoopStepMs(args: {
  fastPathEnabled: boolean;
  bridgeLastEventMs: number | null;
  nowMs: number;
}): number {
  if (!args.fastPathEnabled) return STEP_FAST_MS;
  if (args.bridgeLastEventMs == null) return STEP_FAST_MS;
  const age = args.nowMs - args.bridgeLastEventMs;
  if (!Number.isFinite(age) || age > BRIDGE_STALE_MS) return STEP_FAST_MS;
  return STEP_RELAXED_MS;
}
/**
 * PER-ATTEMPT CEILING — now generous, because an attempt no longer blocks the
 * next one.
 *
 * It used to be 8s, and the loop awaited each attempt before starting another.
 * That is the wrong shape for this upstream. Measured 2026-08-18: races/current
 * either answers between 0.7s and 7.3s, or hangs past 45 SECONDS and never
 * replies — 7 of 12 calls in the second category. So a serial loop spent most of
 * a bad minute asleep on a dead socket, managed ~5 attempts, and on a run of bad
 * minutes wrote nothing at all. The carry froze on heat 34 for fifteen minutes
 * while heats 35 and 36 were called, and every board in the building showed it.
 *
 * Raising the ceiling alone would not have helped — you cannot wait out a
 * request that never returns. What helps is not waiting.
 *
 * SO THE CEILING IS NOW ABOUT RECYCLING THE SLOT, NOT ABOUT PATIENCE. Every
 * observed success was under 7.4s, so 12s keeps healthy headroom while freeing
 * a slot from a hung read four times a minute instead of twice. With five slots
 * that is ~20 attempts a minute rather than the old ~5 — at the measured ~40%
 * answer rate, a minute with no successful write stops being a thing that
 * happens.
 */
const FETCH_TIMEOUT_MS = 12_000;
/**
 * How many reads may be open at once. Enough that a run of hung requests cannot
 * starve the loop, small enough that a wholly dead Pandora does not accumulate
 * sockets for the whole minute.
 */
const MAX_IN_FLIGHT = 5;

const CLAIM_KEY = "races-current:warm-loop";
/** Races run at FastTrax only. */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const TRACKS: TrackKey[] = ["blue", "red", "mega"];

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
  /** Decided ONCE per invocation, not per tick: a bridge that dies mid-minute is
   *  covered by the next minute's loop, and re-reading the heartbeat every second
   *  would put a Redis round trip back into the hot path we are here to remove. */
  const bridgeStamp = await redis.get("kart:bridge:last-event").catch(() => null);
  const bridgeLastEventMs = bridgeStamp ? Date.parse(bridgeStamp) : null;
  const stepMs = warmLoopStepMs({
    fastPathEnabled: venueCalledFastPathEnabled(),
    bridgeLastEventMs: Number.isFinite(bridgeLastEventMs as number) ? bridgeLastEventMs : null,
    nowMs: startedAt,
  });
  let refreshed = 0;
  let failed = 0;
  let rostersWarmed = 0;
  /** Reads currently open. See MAX_IN_FLIGHT. */
  let inFlight = 0;
  /** Ticks where every slot was already occupied — a wholly hung upstream. */
  let starved = 0;
  /** Last session id whose roster we warmed, per track — so a called heat costs
   *  one Pandora read rather than one every second it stays called. */
  const warmedRoster = new Map<TrackKey, string>();
  try {
    while (Date.now() - startedAt < LOOP_BUDGET_MS) {
      // FIRE AND MOVE ON. A hung read must not own the loop's minute, so we do
      // not await it here — we start one a second, up to MAX_IN_FLIGHT, and
      // whichever answers first writes the carry. The staleness guard in
      // refreshRacesCurrent is what makes that safe: an answer that arrives out
      // of order can no longer put an older heat over a newer one.
      if (inFlight < MAX_IN_FLIGHT) {
        inFlight++;
        void refreshRacesCurrent(FETCH_TIMEOUT_MS)
          .then((merged) => {
            refreshed++;

            // WARM THE ROSTER ON THE CALL EVENT, NOT A MINUTE LATER.
            //
            // This loop already knows the exact second a heat becomes called —
            // it is the thing that writes the carry. The ROSTER behind that heat
            // had no such warm: it rode on the check-in-alerts cron, once a
            // minute. So a heat called at 8:15:02 could sit on the desk with no
            // count beside it until 8:16, which is precisely the minute staff
            // are scanning it (owner 2026-08-18: "we need that data soon as we
            // call").
            //
            // ONLY ON CHANGE. The session id we last warmed is remembered per
            // track, so this is one Pandora read per called heat — not one per
            // second.
            for (const track of TRACKS) {
              const sid = merged[track]?.sessionId;
              if (!sid) continue;
              const key = String(sid);
              if (warmedRoster.get(track) === key) continue;
              warmedRoster.set(track, key);
              void warmSessionRoster(FASTTRAX_LOCATION_ID, key, {
                apiKey: process.env.SWAGGER_ADMIN_KEY || "",
                timeoutMs: FETCH_TIMEOUT_MS,
              }).then((list) => {
                if (list) rostersWarmed++;
              });
            }
          })
          .catch(() => {
            failed++;
          })
          .finally(() => {
            inFlight--;
          });
      } else {
        starved++;
      }
      await sleep(stepMs);
    }
  } finally {
    // Release early so the next minute's invocation never waits out the TTL.
    await redis.del(CLAIM_KEY).catch(() => void 0);
  }

  return NextResponse.json({
    ok: true,
    // Which cadence this minute ran at, and why — the first thing to look at if
    // the estate ever feels slow again, or if Pandora traffic does not drop.
    stepMs,
    bridgeLastEvent: bridgeStamp,
    fastPath: venueCalledFastPathEnabled(),
    refreshed,
    failed,
    rostersWarmed,
    starved,
    inFlightAtExit: inFlight,
    ranMs: Date.now() - startedAt,
  });
}
