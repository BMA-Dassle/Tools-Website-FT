import { NextRequest, NextResponse } from "next/server";
import { getReservation, moveReservationLanes, deleteLanePlayer } from "@/lib/qamf-bowling";

/**
 * Safe api-version probe for a QubicaAMF center — confirms it accepts the
 * per-request api-version contract our edit/reschedule code relies on:
 *   - default pinned version (reads)
 *   - "1.2" for the per-player DELETE (reservation-edit roster shrink)
 *   - "1.3" for the lanes PATCH (reschedule / lane move)
 *
 *   GET /api/admin/qamf-internal-test/version-probe?centerId=11542
 *
 * NO reservation is created and NOTHING is mutated: every call targets a
 * NON-EXISTENT reservation id, so the endpoints do nothing. We read the ERROR:
 *   - a "not found" (404) means the version + endpoint were ACCEPTED (the
 *     request reached reservation lookup) → the center supports that contract.
 *   - a version-rejection error (typically 400 mentioning api-version) means
 *     the center does NOT support that version.
 *
 * Built for the FastTrax duckpin migration (center 11542) — validate before
 * staff rely on edit/reschedule, since the center-live probe only proved reads.
 *
 * Auth: under /api/admin/* so middleware.ts gates it.
 */

const DEFAULT_CENTER_ID = 11542;
const FAKE_RESERVATION_ID = "X000000000"; // guaranteed-nonexistent

interface Step {
  step: string;
  apiVersion: string;
  status: number | null;
  accepted: boolean; // version reached lookup (not a version rejection)
  detail: string;
}

/** Pull the HTTP status out of the typed client's error message
 *  ("qamf-bowling <label> failed: <status> <body>"). */
function parseStatus(msg: string): number | null {
  const m = msg.match(/failed:\s*(\d{3})/);
  return m ? Number(m[1]) : null;
}

/** A version is "accepted" if the failure is NOT a version rejection. A 404 (or
 *  any non-version 4xx about the reservation) means the header was honored. */
function classify(msg: string, status: number | null): { accepted: boolean; detail: string } {
  const versionRejected =
    /api-?version|unsupported version|invalid version|version .* not/i.test(msg) && status === 400;
  return {
    accepted: !versionRejected && status != null,
    detail: msg.slice(0, 240),
  };
}

async function probe(name: string, apiVersion: string, fn: () => Promise<unknown>): Promise<Step> {
  try {
    await fn();
    // A success on a fake id is unexpected but still means the version was fine.
    return { step: name, apiVersion, status: 200, accepted: true, detail: "unexpected 2xx" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = parseStatus(msg);
    const { accepted, detail } = classify(msg, status);
    return { step: name, apiVersion, status, accepted, detail };
  }
}

export async function GET(req: NextRequest) {
  if (!process.env.QAMF_BOWLING_CLIENT_ID || !process.env.QAMF_BOWLING_CLIENT_SECRET) {
    return NextResponse.json(
      { ok: false, blocked: "QAMF_BOWLING_CLIENT_ID / QAMF_BOWLING_CLIENT_SECRET not set" },
      { status: 503 },
    );
  }
  const centerId = Number(req.nextUrl.searchParams.get("centerId")) || DEFAULT_CENTER_ID;
  const now = new Date();
  const start = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 90 * 60 * 1000).toISOString();

  const steps: Step[] = [];
  steps.push(
    await probe("getReservation (pinned)", "pinned", () =>
      getReservation(centerId, FAKE_RESERVATION_ID),
    ),
  );
  steps.push(
    await probe("getReservation 1.2 (per-player id schema)", "1.2", () =>
      getReservation(centerId, FAKE_RESERVATION_ID, "1.2"),
    ),
  );
  steps.push(
    await probe("moveReservationLanes 1.3 (reschedule)", "1.3", () =>
      moveReservationLanes(centerId, FAKE_RESERVATION_ID, [
        { Id: "0", LaneNumber: 1, StartTime: start, EndTime: end },
      ]),
    ),
  );
  steps.push(
    await probe("deleteLanePlayer 1.2 (roster shrink)", "1.2", () =>
      deleteLanePlayer(centerId, FAKE_RESERVATION_ID, "0", "0"),
    ),
  );

  const versionsAccepted = steps.every((s) => s.accepted);
  return NextResponse.json({
    centerId,
    note: "No reservation created/mutated — all calls target a nonexistent id.",
    versionsAccepted,
    verdict: versionsAccepted
      ? `center ${centerId} accepts the pinned + 1.2 + 1.3 api-version contract (all calls reached reservation lookup; a real reservation is needed to prove full mutation behavior, incl. the known per-player-DELETE 500)`
      : `center ${centerId} REJECTED one or more api-versions — see steps`,
    steps,
  });
}
