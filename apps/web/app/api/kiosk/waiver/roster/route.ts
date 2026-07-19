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
import { rosterCacheKey, personValidCacheKey } from "~/features/kiosk/waiver/cache";

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
const PERSON_VALID_TTL_SECONDS = 120;
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const WAIVER_CHECK_CONCURRENCY = 5;
const DIGIT_ID = /^\d+$/;

/** Authoritative "has a valid waiver right now" — same Pandora read as
 *  /api/pandora GET (which accepts 17-digit Office ids). Errors → false
 *  (show fewer people rather than fake a signed waiver). */
async function waiverValidNow(personId: string, pandoraLocationId: string): Promise<boolean> {
  const cacheKey = personValidCacheKey(personId);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached === "1") return true;
  if (cached === "0") return false;
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${pandoraLocationId}/${personId}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${PANDORA_KEY}` }, cache: "no-store" },
    );
    const data = await res.json();
    const person = res.ok && data.success ? data.data : null;
    const expiry = person?.waiverExpiry ? new Date(person.waiverExpiry) : null;
    const valid = expiry ? expiry > new Date() : false;
    redis.setex(cacheKey, PERSON_VALID_TTL_SECONDS, valid ? "1" : "0").catch(() => {});
    return valid;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

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
    const valid = registered.filter((_, i) => validFlags[i]);
    const pendingCount = registered.length - valid.length;

    // Union in kiosk joins (written only after a signed/valid waiver). Kiosk
    // joins carry the Pandora SHORT id while BMI projectPersons may surface the
    // 17-digit Office id for the same human — dedupe by personId first, then by
    // display name (cosmetic roster; a rare "John S."+"John S." merge is fine).
    const seenIds = new Set(valid.map((p) => p.personId));
    const seenNames = new Set(valid.map((p) => p.displayName.toLowerCase()));
    for (const j of joins) {
      if (seenIds.has(j.personId)) continue;
      if (seenNames.has(j.displayName.toLowerCase())) continue;
      seenIds.add(j.personId);
      seenNames.add(j.displayName.toLowerCase());
      valid.push({ personId: j.personId, displayName: j.displayName });
    }

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
