import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";
import { laneArrangementEnabled } from "~/features/lane-plan/flags";
import { recheckImminentLanes, RECHECK_HORIZON_MINUTES } from "~/features/lane-plan/recheck.server";
import { recordLaneDecision } from "@/lib/lane-decisions-db";

/**
 * GET /api/cron/lane-recheck
 *
 * The lane a booking gets is chosen once, when its hold is created, and the board moves
 * afterwards: sessions run over, staff open lanes in Conqueror, groups get shifted by hand.
 * This looks again shortly before each booking starts and asks one narrow question — is the
 * lane they are on actually going to be free? — repairing only the ones where the answer is
 * no. It never re-optimises a booking that is fine, because by this point the guest may
 * already have been shown their lane number.
 *
 * FastTrax duckpin only, matching the pilot. Off instantly via LANE_ARRANGEMENT="false".
 *
 * Every 2 minutes (vercel.json), against a RECHECK_HORIZON_MINUTES look-ahead, so a booking
 * cannot slip between two runs.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!laneArrangementEnabled()) {
    return NextResponse.json({ ok: true, skipped: "LANE_ARRANGEMENT=false" });
  }

  const started = Date.now();
  const report = await recheckImminentLanes({ centerId: FASTTRAX_QAMF_CENTER_ID });

  // Only ever say something when something happened — this runs 720 times a day and a log
  // line per run would bury the handful that matter.
  if (report.repairs.length || report.failed.length) {
    console.log(
      `[lane-recheck] scanned=${report.scanned} repairs=${report.repairs.length} ` +
        `moved=${report.moved.length} failed=${report.failed.length} ` +
        report.moved
          .map((m) => `${m.reservationId}:${m.from.join("+")}->${m.to.join("+")}`)
          .join(" ") +
        report.failed.map((f) => ` !${f.reservationId}:${f.reason}`).join(""),
    );
  }

  // Write down every repair. A move that happens minutes before a guest walks up is the
  // one the desk is most likely to ask about later, so it is the one that most needs a row.
  for (const m of report.moved) {
    await recordLaneDecision({
      centerId: FASTTRAX_QAMF_CENTER_ID,
      kind: "recheck",
      reservationId: m.reservationId,
      fromLanes: m.from,
      chosenLanes: m.to,
      outcome: `lane would not have been free — moved ${m.from.join("+")} -> ${m.to.join("+")}`,
    });
  }
  for (const f of report.failed) {
    await recordLaneDecision({
      centerId: FASTTRAX_QAMF_CENTER_ID,
      kind: "recheck",
      reservationId: f.reservationId,
      outcome: `could not repair: ${f.reason}`,
    });
  }

  return NextResponse.json({
    ok: true,
    centerId: FASTTRAX_QAMF_CENTER_ID,
    horizonMinutes: RECHECK_HORIZON_MINUTES,
    ...report,
    ms: Date.now() - started,
  });
}
