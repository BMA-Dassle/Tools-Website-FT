import { NextRequest, NextResponse } from "next/server";
import { listLanes } from "@/lib/qamf-bowling";
import { FASTTRAX_QAMF_CENTER_ID, FASTTRAX_CENTER_CODE } from "@/lib/qamf-centers";
import { getBowlingExperiences } from "@/lib/bowling-db";
import { centerHoursForDate, effectiveToday } from "~/features/booking/service/bowling-hours";
import {
  openLanesFrom,
  laneIsFree,
  fittingDurations,
  nowRounded5EtIso,
  type DurationOption,
} from "~/features/booking/service/bowl-now";

/**
 * GET /api/bowling/v2/bowl-now/availability?lane=N
 *
 * Per-lane snapshot for the FastTrax duckpin "Bowl Now" QR flow. Unlike the
 * center-wide /availability route, this answers the QR's question: is THIS lane
 * free right now, which durations still fit before close, and which other lanes
 * are open (for the in-app swap). Advisory only — the lane-pinned hold
 * (/bowl-now/hold) is the final authority and auto-downgrades.
 *
 * Response: { centerId, lane, laneFree, laneStatus, bookedAt, closeHour24,
 *             webOfferId, durations: [{minutes, optionId}], openLanes }
 */

const CENTER = FASTTRAX_QAMF_CENTER_ID; // 11542 — Bowl Now is FastTrax-duckpin-only
const WEB_OFFER_ID = 5; // FastTrax duckpin offer (30/60/90)
const MAX_LANE = 99; // upper sanity bound; real lanes are validated against listLanes

export async function GET(req: NextRequest) {
  const laneRaw = req.nextUrl.searchParams.get("lane");
  const lane = laneRaw ? Number.parseInt(laneRaw, 10) : NaN;
  if (!Number.isInteger(lane) || lane < 1 || lane > MAX_LANE) {
    return NextResponse.json({ error: "lane must be a positive integer" }, { status: 400 });
  }

  try {
    const lanes = await listLanes(CENTER);
    const laneStatus = lanes.find((l) => l.LaneNumber === lane)?.Status ?? "None";
    const laneFree = laneIsFree(lanes, lane);
    const openLanes = openLanesFrom(lanes);

    const bookedAt = nowRounded5EtIso();
    const date = effectiveToday();
    const { close } = centerHoursForDate(CENTER, date);

    // Durations come from OUR seeded duckpin config (offer 5), never QAMF Minutes.
    const exps = await getBowlingExperiences(FASTTRAX_CENTER_CODE, "hourly");
    const duckpin = exps.find((e) => e.qamfWebOfferId === WEB_OFFER_ID);
    const allDurations: DurationOption[] = (duckpin?.durationOptions ?? []).map((d) => ({
      minutes: d.durationMinutes,
      optionId: d.qamfOptionId,
    }));
    const durations = fittingDurations(allDurations, bookedAt, close);

    return NextResponse.json({
      centerId: CENTER,
      lane,
      laneFree,
      laneStatus,
      bookedAt,
      closeHour24: close,
      webOfferId: WEB_OFFER_ID,
      durations,
      openLanes,
    });
  } catch (err) {
    console.error(
      "[bowling/v2/bowl-now/availability] error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Unable to read lane availability" }, { status: 502 });
  }
}
