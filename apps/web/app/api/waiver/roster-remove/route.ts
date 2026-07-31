import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { removeProjectPersonRow } from "@/lib/bmi-office-actions";
import { removeJoin } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { CENTER_TO_BMI_LOCATION_IDS, isValidCenter } from "~/features/kiosk/waiver/locations";
import { LOCATION_TO_CLIENT_KEY } from "~/features/daily-events/constants";
import { WAIVER_LINK_COOKIE, waiverLinkGrantsOrganizerFor } from "@/lib/waiver-short-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIGIT_ID = /^\d+$/;

/**
 * POST /api/waiver/roster-remove — the ORGANIZER removes a person from the
 * reservation roster. Body: { c, loc, pid, personId }.
 *
 * This is the mutation that was deliberately CUT from the first organizer
 * release (commit e1e145f6 "drop the remove promise") because no BMI removal
 * path was proven. It exists now because the owner captured the Office UI's
 * own call (HAR 2026-07-31) and the live probe PASSED with per-step
 * verification (scripts/office-projectperson-remove-probe.mts).
 *
 * AUTH: the organizer capability, verified server-side against the stored code
 * row and bound to THIS projectId (`waiverLinkGrantsOrganizerFor`) — the same
 * gate the roster itself ships behind. A register code, a forwarded link, or a
 * cookie from another reservation gets 403. This is exactly why remove was
 * unshippable under the old `?r=1`-style flag design: a guessable param would
 * have let anyone holding a share link delete guests from someone's booking.
 *
 * What removal MEANS (and does not): the person is detached from the
 * reservation roster — BMI projectPerson row deleted (verified by re-read,
 * never a bare 200) and our Neon join dropped so the union cannot resurrect
 * them. Their WAIVER and account are untouched: the Pandora signature is the
 * legal record. "Not on the project" counts as success — the goal state is
 * already true (a device-added row that never attached has nothing to remove).
 *
 * Every outcome is logged with ids so a disputed removal is answerable.
 */
export async function POST(req: NextRequest) {
  let body: { c?: unknown; loc?: unknown; pid?: unknown; personId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const center = typeof body.c === "string" ? body.c : "";
  const locationId = Number(typeof body.loc === "string" || typeof body.loc === "number" ? body.loc : NaN);
  const projectId = typeof body.pid === "string" ? body.pid.trim() : "";
  const personId = typeof body.personId === "string" ? body.personId.trim() : "";
  if (
    !isValidCenter(center) ||
    !CENTER_TO_BMI_LOCATION_IDS[center].includes(locationId) ||
    !DIGIT_ID.test(projectId) ||
    !DIGIT_ID.test(personId)
  ) {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const canManage = await waiverLinkGrantsOrganizerFor(
    req.cookies.get(WAIVER_LINK_COOKIE)?.value,
    projectId,
  );
  if (!canManage) {
    return NextResponse.json({ ok: false, error: "Not allowed" }, { status: 403 });
  }

  const clientKey = LOCATION_TO_CLIENT_KEY[locationId];
  if (!clientKey) {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  try {
    const result = await removeProjectPersonRow({ clientKey, projectId, personId });
    // Our Neon join goes regardless of the BMI outcome shape — if the person
    // was never attached (not-on-project), the join may still exist and would
    // keep resurrecting them in the roster union.
    const joinDropped = await removeJoin(projectId, personId).catch(() => false);

    if (!result.removed && result.reason !== "not-on-project") {
      console.error(
        `[waiver-roster-remove] FAILED loc=${locationId} pid=${projectId} person=${personId}: ${result.reason}`,
      );
      return NextResponse.json({ ok: false, error: "Removal failed" }, { status: 502 });
    }

    // Bust both context caches so the next load re-sweeps and the roster (and
    // the "N of M" fraction) reflect the removal instead of serving the
    // pre-removal snapshot for up to 2 minutes.
    await Promise.all([
      redis.del(`waiver:ctx:${locationId}:${projectId}`).catch(() => {}),
      redis.del(`waiver:ctx:state:v2:${locationId}:${projectId}`).catch(() => {}),
    ]);

    console.log(
      `[waiver-roster-remove] loc=${locationId} pid=${projectId} person=${personId} ` +
        `bmi=${result.removed ? `removed row ${result.rowId}` : "not-on-project"} join=${joinDropped ? "dropped" : "none"}`,
    );
    return NextResponse.json(
      { ok: true, bmiRemoved: result.removed, joinDropped },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (err) {
    console.error(
      `[waiver-roster-remove] error loc=${locationId} pid=${projectId} person=${personId}:`,
      err,
    );
    return NextResponse.json({ ok: false, error: "Removal failed" }, { status: 502 });
  }
}
