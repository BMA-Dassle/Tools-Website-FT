/**
 * Lane arrangement — put a freshly created hold on a better lane. FastTrax pilot.
 *
 * TWO ENTRY POINTS, AND WHICH ONE TO REACH FOR
 *
 *  - `planLanesForNewBooking` — choose BEFORE the reservation exists, so an unavailable
 *    lane is never picked in the first place. This is the right one for a walk-up.
 *  - `placeReservationOnBestLane` — move an existing booking. Repairs a lane that will
 *    not be free, and improves one QAMF picked when planning failed open.
 *
 * An earlier version of this file argued that pinning was impossible because it needs a
 * lane COUNT before QAMF has decided one. That was WRONG: `bowlingLaneCount` (6 players
 * per lane) is our own rule, already used to price the booking and by the per-lane QR
 * flow, so the count was never a guess. The correction matters, because "repair it
 * afterwards" is not good enough for a guest bowling immediately — the owner's 2026-08-31
 * report was a kiosk walk-up that landed on lane 1 while lane 1 was still running.
 *
 * The move path is still proven live (2026-08-24, X163651 at Fort Myers: 13+14 -> 15+16
 * -> 13+14, lane Ids intact, times untouched), and still runs from `after()` so a hold
 * returns at exactly the speed it did before.
 */
import { getReservation, moveReservationLanes } from "@/lib/qamf-bowling";
import { getBowlingExperiences } from "@/lib/bowling-db";
import { bowlingLaneCount } from "~/features/booking/service/bowling-offer";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { resolveOptionMinutes } from "~/features/booking/service/duration-feasibility";
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

/** Ranked lane sets tried before falling open. Each is one live vendor round-trip. */
const MAX_CANDIDATES = 3;

/** Planning must never hold up a guest's hold. Past this, take QAMF's lane and move on. */
export const PLAN_BUDGET_MS = 2_500;

/**
 * Choose the lane BEFORE the reservation exists, so an unavailable one is never picked.
 *
 * The owner's 2026-08-31 report was a walk-up bought at the kiosk that landed on lane 1
 * while lane 1 was still running — and repairing that after the fact is not good enough
 * for someone bowling immediately. QAMF auto-assigns off the schedule and fills from the
 * lowest lane number up; it never consults the physical floor. The grid does, so choosing
 * here is the difference between preventing the problem and apologising for it.
 *
 * The lane COUNT is not a guess: `bowlingLaneCount` (6 players per lane) is our own rule,
 * already used to price the booking and by the per-lane QR flow.
 *
 * Returns ranked lane sets, best first. An EMPTY array means "no opinion" — the caller
 * creates exactly as it always did and QAMF decides. Never throws.
 */
export async function planLanesForNewBooking(opts: {
  centerId: number;
  bookedAtMs: number;
  players: number;
  webOfferId: number;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  policy?: LanePolicy;
}): Promise<number[][]> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  try {
    const centerCode = QAMF_TO_CENTER_CODE[opts.centerId];
    if (!centerCode) return [];

    const experiences = (await getBowlingExperiences(centerCode, undefined, true)).filter(
      (e) => e.qamfWebOfferId === opts.webOfferId,
    );
    const minutes = resolveOptionMinutes(experiences, opts.optionId, opts.optionType);
    // Game/Unlimited have no bounded window, so we cannot say which lanes stay free for it.
    // Better to leave the lane to QAMF than to reserve one against a made-up end time.
    if (minutes == null) return [];

    const startMs = opts.bookedAtMs;
    const endMs = startMs + minutes * 60_000;
    const grid = await buildGrid(opts.centerId, startMs - GRID_PAD_MS, endMs + GRID_PAD_MS);

    const req: PlanRequest = {
      laneCount: bowlingLaneCount(opts.players),
      startMs,
      endMs,
      players: opts.players,
      webOfferId: opts.webOfferId,
      // FastTrax sells one offer across every lane — see flags.ts for why this pilot is
      // scoped to the one house where that is true.
      allowedLanes: null,
    };

    const { ranked } = chooseLanes(grid, req, policy);
    return ranked.slice(0, MAX_CANDIDATES).map((p) => p.lanes);
  } catch (err) {
    console.warn("[lane-plan] pre-create planning failed (QAMF will choose):", err);
    return [];
  }
}

/** Plan, but never spend more than the budget on it. Timeout = no opinion. */
export async function planLanesWithinBudget(
  opts: Parameters<typeof planLanesForNewBooking>[0] & { budgetMs?: number },
): Promise<number[][]> {
  const budget = opts.budgetMs ?? PLAN_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      planLanesForNewBooking(opts),
      new Promise<number[][]>((resolve) => {
        timer = setTimeout(() => resolve([]), budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
