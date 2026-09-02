import { after, NextRequest, NextResponse } from "next/server";
import { createReservation } from "@/lib/qamf-bowling";
import { shouldArrangeLane } from "~/features/lane-plan/flags";
import {
  placeReservationOnBestLane,
  planLanesWithinBudget,
} from "~/features/lane-plan/place.server";
import { createWithLanePlan, describePinOutcome } from "~/features/lane-plan/pin";
import { recordLaneDecision } from "@/lib/lane-decisions-db";
import {
  freeLaneCandidates,
  immediateLaneGuardEnabled,
  isImmediateStart,
} from "~/features/booking/service/immediate-lane-guard";
import {
  assertBookable,
  DurationGuardError,
  qamfSlotTakenMessage,
} from "~/features/booking/service/duration-guard";
import {
  isMidnightMadnessSlug,
  midnightMadnessWindowError,
} from "~/features/booking/service/bowling-offer";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";

/**
 * POST /api/bowling/v2/reserve/hold
 *
 * Creates a QAMF Temporary reservation ("hold") as soon as the user
 * selects their experience on the offer step. The slot is held until
 * the user completes checkout or navigates away.
 *
 * The hold is extended every ~8 minutes by the wizard via
 * PATCH /api/bowling/v2/reserve/hold/[qamfId].
 *
 * At submit time, /api/bowling/v2/reserve accepts an optional
 * `qamfReservationId` to use the existing hold rather than creating a
 * fresh reservation — this prevents a double-booking race.
 *
 * Body: { centerId, webOfferId, optionId?, optionType?, bookedAt, players, service? }
 * Response: { qamfReservationId, expiresAt, status }
 */

const VALID_CENTER_IDS = new Set([9172, 3148, FASTTRAX_QAMF_CENTER_ID]);

interface HoldBody {
  centerId: number;
  webOfferId: number;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  bookedAt: string;
  players: number;
  service?: "BookForLater" | "PlayNow";
  /** Experience the hold is for. Midnight Madness shares its webOfferId with
   *  the all-day Fri-Sun hourly offer, so the slug is the only signal that
   *  lets this route apply MM's late-night sales window. Optional — the
   *  reserve route re-checks fail-closed via the MM product lines. */
  experienceSlug?: string;
}

export async function POST(req: NextRequest) {
  let body: HoldBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { centerId, webOfferId, bookedAt, players } = body;

  if (!centerId || !webOfferId || !bookedAt || !players) {
    return NextResponse.json(
      { error: "centerId, webOfferId, bookedAt, and players are required" },
      { status: 400 },
    );
  }

  if (!VALID_CENTER_IDS.has(centerId)) {
    return NextResponse.json({ error: `unknown centerId: ${centerId}` }, { status: 400 });
  }

  // Midnight Madness sales window (server-side — the client slot gates are
  // display-only). Reject before the QAMF hold so the guest gets immediate
  // feedback instead of failing later at payment.
  if (isMidnightMadnessSlug(body.experienceSlug)) {
    const windowError = midnightMadnessWindowError(bookedAt);
    if (windowError) {
      console.log(`[bowling/v2/reserve/hold] MM window rejected: bookedAt=${bookedAt}`);
      return NextResponse.json({ error: windowError, code: "mm_outside_window" }, { status: 400 });
    }
  }

  const optionType = body.optionType ?? "Game";
  const optionId = body.optionId;
  const service = body.service ?? "BookForLater";

  const qamfOptions: {
    Game?: { Id: number }[];
    Time?: { Id: number }[];
    Unlimited?: { Id: number }[];
  } = {};
  if (optionId) {
    if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
    else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
    else qamfOptions.Game = [{ Id: optionId }];
  }

  // Duration/option guard: reject options that don't belong to the offer,
  // durations past close, and durations whose occupancy window is provably
  // blocked — BEFORE creating the QAMF hold. Typed codes let the wizard
  // refresh its slot grid instead of dead-ending. Fail-open on guard
  // infrastructure errors (QAMF createReservation stays the final authority).
  try {
    await assertBookable({
      centerId,
      webOfferId,
      optionId,
      optionType,
      bookedAt,
      players,
      mode: "full",
      logTag: "[bowling/v2/reserve/hold]",
    });
  } catch (err) {
    if (err instanceof DurationGuardError) {
      console.log(`[bowling/v2/reserve/hold] guard rejected (${err.code}): ${err.message}`);
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.warn("[bowling/v2/reserve/hold] duration guard errored (fail-open):", err);
  }

  // LANE ARRANGEMENT (FastTrax pilot). Same-day only, FastTrax only, off instantly via
  // LANE_ARRANGEMENT="false".
  //
  // The lane is chosen BEFORE the reservation exists. QAMF auto-assigns off the schedule
  // and fills from the lowest lane number up — it never looks at the physical floor, which
  // is how a kiosk walk-up landed on lane 1 while lane 1 was still running (2026-08-31).
  // Our grid reads both, so choosing here prevents that rather than apologising for it.
  //
  // Bounded by PLAN_BUDGET_MS: no guest waits on lane planning. A timeout, a slow read or
  // any failure yields an empty candidate list, and `createWithLanePlan` then creates with
  // no `Lanes` at all — byte-identical to the behaviour that predates this feature.
  const bookedAtMs = Date.parse(bookedAt);
  const nowMs = Date.now();
  const arranging = shouldArrangeLane({ centerId, bookedAtMs, nowMs });

  const preferred = arranging
    ? await planLanesWithinBudget({
        centerId,
        bookedAtMs,
        players,
        webOfferId,
        optionId,
        optionType,
      })
    : [];

  // AVAILABILITY GUARD — every centre, always on, independent of the arrangement pilot.
  // Arrangement decides which free lane is best; this decides whether a lane is usable at
  // all. For a guest starting now, never offer one somebody is physically still on.
  const guard =
    immediateLaneGuardEnabled() && isImmediateStart(bookedAtMs, nowMs)
      ? await freeLaneCandidates({ centerId, players, preferred })
      : { candidates: preferred, freeLanes: [] as number[] };
  const candidates = guard.candidates;

  try {
    const outcome = await createWithLanePlan({
      candidates,
      create: (lanes) =>
        createReservation(centerId, {
          BookedAt: bookedAt,
          Title: `Hold (${players}p)`,
          WebOffer: {
            Id: webOfferId,
            Options: qamfOptions,
            Services: [service],
          },
          TotalPlayers: players,
          ...(lanes ? { Lanes: lanes.map((LaneNumber) => ({ LaneNumber })) } : {}),
        }),
    });
    const reservation = outcome.reservation;

    if (candidates.length) {
      console.log(`[bowling/v2/reserve/hold] ${reservation.Id} ${describePinOutcome(outcome)}`);
    }

    // Write the decision down. Everything needed to answer "why that lane?" without
    // reconstructing the board from memory: what was free, what we were willing to ask for,
    // what the vendor said, and where the guest ended up. Fired in `after()` so the log can
    // never be the reason a hold is slow, and it swallows its own errors either way.
    after(() =>
      recordLaneDecision({
        centerId,
        kind: "place",
        reservationId: reservation.Id,
        bookedAt,
        players,
        webOfferId,
        freeLanes: guard.freeLanes,
        allowedLanes: preferred.length ? preferred.flat() : null,
        candidates,
        chosenLanes: outcome.pinnedTo ?? (reservation.Lanes ?? []).map((l) => l.LaneNumber),
        failedOpen: outcome.failedOpen,
        attempts: outcome.attempts,
        outcome: candidates.length ? describePinOutcome(outcome) : "no opinion — QAMF chose",
      }),
    );

    // Only when the pin found no home does QAMF's own choice need improving, and that runs
    // in `after()` so the response stays exactly as fast as it was.
    if (arranging && outcome.failedOpen) {
      after(() =>
        placeReservationOnBestLane({ centerId, reservationId: reservation.Id }).then(
          (r) =>
            r.moved &&
            console.log(
              `[bowling/v2/reserve/hold] ${reservation.Id} lane ${r.from.join("+")} -> ${r.to.join("+")}`,
            ),
        ),
      );
    }

    return NextResponse.json({
      qamfReservationId: reservation.Id,
      expiresAt: reservation.ExpiresAt ?? null,
      status: reservation.Status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF hold failed";
    console.error("[bowling/v2/reserve/hold] POST error:", msg);
    // Lane-fit/availability rejections become a typed 409 the UI can recover
    // from (refresh slots) instead of an opaque 502.
    const taken = qamfSlotTakenMessage(err);
    if (taken) {
      // `detail` carries QAMF's raw reason so an offer-level misconfiguration
      // (every hold on one offer 409ing — the 2026-07-31 Midnight Madness
      // outage) is distinguishable from a genuine slot race without log
      // access. The wizard renders only `error`.
      return NextResponse.json(
        { error: taken, code: "slot_taken", detail: msg.slice(0, 500) },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
