import { NextRequest, NextResponse } from "next/server";
import {
  createReservation,
  getReservation,
  deleteReservation,
  listLanes,
} from "@/lib/qamf-bowling";
import { qamfSlotTakenMessage } from "~/features/booking/service/duration-guard";
import { FASTTRAX_QAMF_CENTER_ID, FASTTRAX_CENTER_CODE } from "@/lib/qamf-centers";
import { getBowlingExperiences } from "@/lib/bowling-db";
import { buildBowlingLineItems, bowlingLaneCount } from "~/features/booking/service/bowling-offer";
import { centerHoursForDate, effectiveToday } from "~/features/booking/service/bowling-hours";
import {
  openLanesFrom,
  laneIsFree,
  fittingDurations,
  nowRounded5EtIso,
  type DurationOption,
} from "~/features/booking/service/bowl-now";

/**
 * POST /api/bowling/v2/bowl-now/hold
 *
 * The scan-time hold for the FastTrax duckpin "Bowl Now" QR: the instant a
 * guest scans lane N's QR we PIN that lane and reserve the longest window that
 * fits, so nobody else can take it during the ~2-min sign-in → pay flow.
 *
 * Auto-downgrade: try 90 → 60 → 30 (longest first, close-clamped). The first
 * duration whose lane-pinned hold lands is the ceiling. BookForLater = a 10-min
 * hold the wizard extends; an abandoned scan auto-frees the lane. The lane is
 * OPENED later (post-payment), not here.
 *
 * Method A (pin-at-create): createReservation with Lanes:[{LaneNumber:N}].
 * If QAMF ignores the pin (assigns elsewhere) we surface pin_unsupported — the
 * signal to switch to moveReservationLanes (see scripts/qamf-lane-pin-probe.ts).
 *
 * Body: { lane, players? }
 * Response: { qamfReservationId, laneNumber, durationMinutes, optionId, webOfferId, bookedAt, expiresAt }
 * 409 codes: lane_unavailable (busy / can't pin), past_close (nothing fits)
 */

const CENTER = FASTTRAX_QAMF_CENTER_ID; // 11542 — Bowl Now is FastTrax-duckpin-only
const WEB_OFFER_ID = 5;

interface HoldBody {
  lane: number;
  players?: number;
  /** Hold EXACTLY this duration (the "How long?" step picking shorter than the
   *  scan-time ceiling). Omitted at scan time → auto-pick the longest that fits. */
  optionId?: number;
  /** A prior hold to release once this one lands (re-issuing at a new duration
   *  or a swapped lane) — so there's never more than one live hold. */
  replaceReservationId?: string;
}

export async function POST(req: NextRequest) {
  let body: HoldBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const lane = Number(body.lane);
  if (!Number.isInteger(lane) || lane < 1) {
    return NextResponse.json({ error: "lane must be a positive integer" }, { status: 400 });
  }
  const players = Math.max(1, Math.min(24, Math.floor(body.players ?? 2)));

  try {
    // 1) Is the scanned lane physically free right now?
    const lanes = await listLanes(CENTER);
    if (!laneIsFree(lanes, lane)) {
      return NextResponse.json(
        {
          error: `Lane ${lane} is in play right now.`,
          code: "lane_unavailable",
          openLanes: openLanesFrom(lanes),
        },
        { status: 409 },
      );
    }

    // 2) Which durations still fit before close (longest first)?
    const bookedAt = nowRounded5EtIso();
    const { close } = centerHoursForDate(CENTER, effectiveToday());
    const exps = await getBowlingExperiences(FASTTRAX_CENTER_CODE, "hourly");
    const duckpin = exps.find((e) => e.qamfWebOfferId === WEB_OFFER_ID);
    const allDurations: DurationOption[] = (duckpin?.durationOptions ?? []).map((d) => ({
      minutes: d.durationMinutes,
      optionId: d.qamfOptionId,
    }));
    let candidates = fittingDurations(allDurations, bookedAt, close);
    // Explicit duration pick (the "How long?" step): hold exactly that one, no
    // downgrade — if it no longer fits (time slipped past close), 409 so the
    // client re-reads availability.
    if (body.optionId != null) {
      candidates = candidates.filter((c) => c.optionId === Number(body.optionId));
    }
    if (candidates.length === 0) {
      return NextResponse.json(
        {
          error: "No duckpin time fits before we close.",
          code: "past_close",
          openLanes: openLanesFrom(lanes),
        },
        { status: 409 },
      );
    }

    // 3) Auto-downgrade: pin the lane at the longest duration that holds.
    for (const { minutes, optionId } of candidates) {
      let createdId: string | null = null;
      try {
        const res = await createReservation(CENTER, {
          BookedAt: bookedAt,
          Title: `Bowl Now — Lane ${lane} (${players}p)`,
          WebOffer: {
            Id: WEB_OFFER_ID,
            Options: { Time: [{ Id: optionId }] },
            Services: ["BookForLater"],
          },
          TotalPlayers: players,
          Lanes: [{ LaneNumber: lane }],
        });
        createdId = res.Id;
        const got = await getReservation(CENTER, res.Id);
        const assigned = (got.Lanes ?? []).map((l) => l.LaneNumber);
        if (assigned.length === 1 && assigned[0] === lane) {
          // Release the prior hold (duration change / lane swap) — new one is safe.
          if (body.replaceReservationId && body.replaceReservationId !== res.Id) {
            await deleteReservation(CENTER, body.replaceReservationId).catch(() => {});
          }
          // Build the Square line items now (per-lane duckpin pricing) so the
          // client stores exactly what checkout quotes/charges — displayed ==
          // charged. durationOpt carries the per-duration price override.
          const durationOpt =
            (duckpin?.durationOptions ?? []).find((d) => d.qamfOptionId === optionId) ?? null;
          const laneCount = bowlingLaneCount(players);
          const lineItems = duckpin
            ? buildBowlingLineItems(duckpin, durationOpt, players, laneCount)
            : [];
          const priceCents = lineItems.reduce(
            (sum, li) => sum + (li.priceCents ?? 0) * li.quantity,
            0,
          );
          return NextResponse.json({
            qamfReservationId: res.Id,
            laneNumber: lane,
            durationMinutes: minutes,
            optionId,
            optionType: "Time" as const,
            webOfferId: WEB_OFFER_ID,
            bookedAt,
            expiresAt: res.ExpiresAt ?? null,
            experienceId: duckpin?.id ?? null,
            experienceSlug: duckpin?.slug ?? null,
            durationOptionId: durationOpt?.id ?? null,
            durationMultiplier: durationOpt?.squareMultiplier ?? 1,
            laneCount,
            lineItems,
            priceCents,
          });
        }
        // Pin ignored — QAMF auto-assigned [assigned]. Method A unsupported for
        // this offer's lane groups; a shorter duration won't pin either. Bail.
        await deleteReservation(CENTER, res.Id);
        console.error(
          `[bowl-now/hold] PIN IGNORED lane ${lane} → assigned [${assigned.join(",")}]. Switch to moveReservationLanes.`,
        );
        return NextResponse.json(
          {
            error: "Couldn't hold that exact lane.",
            code: "pin_unsupported",
            openLanes: openLanesFrom(lanes),
          },
          { status: 409 },
        );
      } catch (err) {
        if (createdId) await deleteReservation(CENTER, createdId).catch(() => {});
        // Lane-fit/slot rejection for THIS duration → try the next-shorter one.
        if (qamfSlotTakenMessage(err)) continue;
        throw err;
      }
    }

    // Every duration was rejected → the lane can't take even the shortest now.
    return NextResponse.json(
      {
        error: `Lane ${lane} just filled up.`,
        code: "lane_unavailable",
        openLanes: openLanesFrom(lanes),
      },
      { status: 409 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF hold failed";
    console.error("[bowl-now/hold] error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
