/**
 * Lane arrangement — put a freshly created hold on a better lane. FastTrax pilot.
 *
 * WHY MOVE INSTEAD OF PIN AT CREATE
 *
 * Pinning needs a lane COUNT before QAMF has decided one, and FastTrax is not reliably
 * one-lane-per-party: the Aug 1 and Aug 8 boards each carried a booking spanning two.
 * Guessing wrong costs a 409 per candidate on a request a guest is waiting through, and
 * guessing conservatively means never pinning the parties that matter most.
 *
 * Creating first removes the guess entirely — QAMF's own response says how many lanes the
 * booking got — and it removes the risk with it: the hold EXISTS before we try to improve
 * it, so no failure here can cost a booking. That is a stronger guarantee than the
 * pin-at-create walk gives, not a weaker one.
 *
 * The move itself is proven live (2026-08-24, X163651 at Fort Myers: 13+14 -> 15+16 ->
 * 13+14, lane Ids intact, times untouched). It is invisible to the guest: no surface names
 * a lane before check-in, and this runs on a Temporary hold that nobody has been told
 * anything about yet.
 *
 * Called from `after()` so the guest's hold returns at exactly the speed it did before.
 */
import { getReservation, moveReservationLanes } from "@/lib/qamf-bowling";
import { buildGrid } from "./grid.server";
import { chooseLanes } from "./policy";
import { scorePlacement, spreadBias } from "./score";
import { DEFAULT_POLICY, type LanePolicy, type PlanRequest } from "./types";

/** How much board to read either side of the booking — enough for neighbours and pair-mates. */
const GRID_PAD_MS = 4 * 60 * 60_000;

export interface PlaceResult {
  moved: boolean;
  from: number[];
  to: number[];
  reason: string;
}

const skip = (reason: string): PlaceResult => ({ moved: false, from: [], to: [], reason });

/**
 * Re-place one reservation on the best lane the policy can find.
 *
 * NEVER THROWS. A lane preference must not cost a booking, and this runs after the guest
 * already has one — so every failure path is a no-op that leaves QAMF's own choice alone.
 */
export async function placeReservationOnBestLane(opts: {
  centerId: number;
  reservationId: string;
  policy?: LanePolicy;
  /**
   * Skip the `moveCost` gate.
   *
   * Set only for a REPAIR, where the lane the booking is on is not actually going to be
   * free. Staying put is not one of the options, so a marginal score gain is not the
   * question — anywhere free beats a lane with somebody on it.
   */
  force?: boolean;
  /** Injected in tests. */
  now?: number;
}): Promise<PlaceResult> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const tag = `[lane-plan] ${opts.reservationId}`;

  try {
    const reservation = await getReservation(opts.centerId, opts.reservationId);
    const lanes = reservation.Lanes ?? [];
    if (lanes.length === 0) return skip("reservation has no lanes");

    // Every lane must carry the fields the PATCH echoes back. A partial row would mean
    // sending a reconstructed time, and a reconstructed time is how a booking's window
    // silently shifts.
    const rows = lanes.filter((l) => l.Id && l.StartTime && l.EndTime);
    if (rows.length !== lanes.length) return skip("a lane row is missing Id/StartTime/EndTime");

    const startMs = Math.min(...rows.map((l) => Date.parse(l.StartTime)));
    const endMs = Math.max(...rows.map((l) => Date.parse(l.EndTime)));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return skip("unparseable lane window");
    }

    const current = rows.map((l) => l.LaneNumber);
    const grid = await buildGrid(opts.centerId, startMs - GRID_PAD_MS, endMs + GRID_PAD_MS);

    const req: PlanRequest = {
      reservationId: opts.reservationId,
      laneCount: rows.length,
      startMs,
      endMs,
      players: reservation.TotalPlayers ?? rows.reduce((n, l) => n + (l.Players?.length ?? 0), 0),
      webOfferId: reservation.WebOffer?.Id ?? null,
      // FastTrax sells ONE offer across all eight lanes, so there is no group to respect
      // and deriving one would cost a 60-day history read per hold for no information.
      // This is the assumption that keeps the pilot to FastTrax — see flags.ts.
      allowedLanes: null,
    };

    const bias = spreadBias(grid, req, policy);
    const currentScore = scorePlacement(grid, req, current, policy, bias).score;
    const { best } = chooseLanes(grid, req, policy);

    if (!best) return skip("no candidate lane set free for the window");
    const gain = best.score - currentScore;
    if (best.lanes.join(",") === current.join(",")) {
      return { moved: false, from: current, to: current, reason: "already on the best lane" };
    }
    // Staying put is the default. A move has to earn more than the churn it causes —
    // unless this is a repair, where staying put means walking the guest onto a lane
    // somebody else is on.
    if (!opts.force && gain <= policy.moveCost) {
      return {
        moved: false,
        from: current,
        to: best.lanes,
        reason: `better lane not worth the move (+${gain.toFixed(1)} <= ${policy.moveCost})`,
      };
    }

    // Times and lane Ids go back EXACTLY as QAMF gave them — they are already center-local
    // wall clock with the true offset. Only LaneNumber changes, which is what makes this an
    // in-place move rather than a rebuild.
    await moveReservationLanes(
      opts.centerId,
      opts.reservationId,
      rows.map((l, i) => ({
        Id: l.Id,
        LaneNumber: best.lanes[i] ?? l.LaneNumber,
        StartTime: l.StartTime as string,
        EndTime: l.EndTime as string,
      })),
    );

    console.log(
      `${tag} moved ${current.join("+")} -> ${best.lanes.join("+")} (+${gain.toFixed(1)})`,
    );
    return { moved: true, from: current, to: best.lanes, reason: `+${gain.toFixed(1)}` };
  } catch (err) {
    // The guest already has their hold on QAMF's lane. Losing the improvement is a
    // non-event; losing the booking would not be.
    console.warn(`${tag} lane placement failed (booking unaffected):`, err);
    return skip(err instanceof Error ? err.message : String(err));
  }
}
