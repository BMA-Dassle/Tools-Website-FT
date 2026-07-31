import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { makeDisplayName } from "@/lib/display-name";
import { getReservationDetail } from "~/features/daily-events/service";
import { listJoinsForProject } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import {
  CENTER_TO_BMI_LOCATION_IDS,
  BMI_LOCATION_TO_PANDORA_KEY,
  isValidCenter,
} from "~/features/kiosk/waiver/locations";
import { PANDORA_LOCATION_MAP, PANDORA_DEFAULT_LOCATION_ID } from "@/lib/pandora-locations";
import { rosterCacheKey } from "~/features/kiosk/waiver/cache";
import {
  waiverValidNow,
  mapWithConcurrency,
  unionValidWithJoins,
  pendingRegisteredCount,
  WAIVER_CHECK_CONCURRENCY,
} from "~/features/kiosk/waiver/valid-count";

export const dynamic = "force-dynamic";

/**
 * GET /api/kiosk/waiver/roster?center=…&locationId=…&projectId=…
 *
 * Who's already squared away on a reservation: "First L." of everyone
 * REGISTERED on it (BMI projectPersons) whose waiver is CURRENTLY VALID
 * (Pandora waiverExpiry > now — the Office lookup can't see waiverExpiry),
 * unioned with our Neon kiosk_waiver_joins (source of record — a guest whose
 * BMI attach failed still appears). PII-lean: display names only; full
 * names/emails/phones/birthdates never reach the kiosk browser.
 */

const ROSTER_CACHE_TTL_SECONDS = 30; // join POST DELs this so post-add refetches are fresh
const DIGIT_ID = /^\d+$/;

// waiverValidNow / mapWithConcurrency / unionValidWithJoins now live in
// ~/features/kiosk/waiver/valid-count so /api/waiver/context can reuse the exact
// same "who is actually signed" rule without also returning guest names.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const center = sp.get("center") ?? "";
  const locationId = Number(sp.get("locationId") ?? "");
  const projectId = sp.get("projectId") ?? "";
  if (
    !isValidCenter(center) ||
    !CENTER_TO_BMI_LOCATION_IDS[center].includes(locationId) ||
    !DIGIT_ID.test(projectId)
  ) {
    return NextResponse.json({ success: false, error: "Invalid query" }, { status: 400 });
  }

  const cacheKey = rosterCacheKey(projectId);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (typeof cached === "string" && cached) {
    return new NextResponse(cached, {
      status: 200,
      headers: { "content-type": "application/json", "x-kiosk-cache": "hit" },
    });
  }

  try {
    const pandoraLocationId =
      PANDORA_LOCATION_MAP[BMI_LOCATION_TO_PANDORA_KEY[locationId] ?? ""] ||
      PANDORA_DEFAULT_LOCATION_ID;

    const [detail, joins] = await Promise.all([
      getReservationDetail(locationId, projectId),
      listJoinsForProject(projectId),
    ]);

    const registered = (detail.persons_list || [])
      .map((p) => ({
        personId: String(p.personId ?? p.id ?? ""),
        displayName: makeDisplayName(p.firstName || "", p.name || ""),
      }))
      .filter((p) => p.personId && p.displayName);

    const validFlags = await mapWithConcurrency(registered, WAIVER_CHECK_CONCURRENCY, (p) =>
      waiverValidNow(p.personId, pandoraLocationId),
    );
    // Union in kiosk joins (written only after a signed/valid waiver) — same rule
    // the public waiver context counts with.
    const valid = unionValidWithJoins(registered, validFlags, joins);
    // Per-person over the REGISTERED set — the union also holds walk-in joins, so
    // `registered.length - valid.length` went negative / hid the pending banner.
    const pendingCount = pendingRegisteredCount(registered, validFlags, joins);

    const body = JSON.stringify({
      success: true,
      projectId,
      // No label here on purpose: for online reservations detail.name is the
      // guest's FULL name — the client already has the redacted picker label.
      people: valid.map((p) => ({ personId: p.personId, displayName: p.displayName })),
      counts: {
        registered: registered.length,
        valid: valid.length,
        pending: pendingCount,
      },
    });
    redis.setex(cacheKey, ROSTER_CACHE_TTL_SECONDS, body).catch(() => {});
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": "application/json", "x-kiosk-cache": "miss" },
    });
  } catch (error) {
    console.error("[kiosk-waiver] roster error:", error);
    return NextResponse.json({ success: false, error: "Failed to load roster" }, { status: 502 });
  }
}
