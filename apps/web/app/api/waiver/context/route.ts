import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { displayNameFromFull } from "@/lib/display-name";
import { getReservationDetail } from "~/features/daily-events/service";
import { listJoinsForProject } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import {
  CENTER_TO_BMI_LOCATION_IDS,
  BMI_LOCATION_TO_PANDORA_KEY,
  isValidCenter,
} from "~/features/kiosk/waiver/locations";
import { PANDORA_LOCATION_MAP, PANDORA_DEFAULT_LOCATION_ID } from "@/lib/pandora-locations";
import {
  waiverValidNow,
  mapWithConcurrency,
  unionValidWithJoins,
  WAIVER_CHECK_CONCURRENCY,
} from "~/features/kiosk/waiver/valid-count";
import { makeDisplayName } from "@/lib/display-name";

export const dynamic = "force-dynamic";

/**
 * GET /api/waiver/context?c=<center>&loc=<locationId>&pid=<projectId>
 *
 * The lean, PII-safe summary that lets the reservation-scoped /waiver page show
 * an event-info header WITHOUT exposing the confirmation. This is what makes the
 * link safe to forward to a whole party: it returns only the reservation NAME
 * (online names reduced to "First L."), activity, when, center and guest count —
 * NEVER pricing, deposit, payments, balance, or other guests' PII (the heavy
 * getReservationDetail carries all of that; we deliberately drop it here).
 *
 * Cached 120s per (loc, pid): getReservationDetail is several BMI calls, and the
 * summary is effectively static for an event, so a forwarded link that many
 * people open costs ~0 BMI load.
 */

const DIGIT_ID = /^\d+$/;
const CACHE_TTL_SECONDS = 120;

const LOCATION_NAMES: Record<number, string> = {
  467486: "FastTrax Fort Myers",
  332160: "HeadPinz Fort Myers",
  332145: "HeadPinz Naples",
};

/** Naive ET stamp "YYYY-MM-DDTHH:mm:ss" → "Sat, Aug 2 · 2:00 PM". */
function formatWhen(when?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(when ?? "");
  if (!m) return "";
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const h = Number(hh);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateLabel} · ${h12}:${mm} ${ampm}`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const center = sp.get("c") ?? "";
  const locationId = Number(sp.get("loc") ?? "");
  const projectId = sp.get("pid") ?? "";
  if (
    !isValidCenter(center) ||
    !CENTER_TO_BMI_LOCATION_IDS[center].includes(locationId) ||
    !DIGIT_ID.test(projectId)
  ) {
    return NextResponse.json({ ok: false, error: "Invalid query" }, { status: 400 });
  }

  const cacheKey = `waiver:ctx:${locationId}:${projectId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (typeof cached === "string" && cached) {
    return new NextResponse(cached, {
      status: 200,
      headers: { "content-type": "application/json", "x-waiver-cache": "hit" },
    });
  }

  try {
    const [detail, joins] = await Promise.all([
      getReservationDetail(locationId, projectId),
      listJoinsForProject(projectId).catch(() => []),
    ]);

    // Online reservations stuff the guest's FULL name into detail.name — reduce
    // to "First L." (group functions use a real event name, kept as-is).
    const isOnline = (detail.kind || "").toLowerCase().includes("online");
    const rawName = (detail.name || "").trim();
    const label = isOnline
      ? !rawName || rawName.toLowerCase() === "online"
        ? "Your reservation"
        : displayNameFromFull(rawName)
      : rawName || "Your reservation";

    const activities = Array.from(
      new Set(
        (detail.schedules || [])
          .map((s) => ((s as { resourceName?: string }).resourceName || "").trim())
          .filter(Boolean),
      ),
    );

    // "N of M registered" for the event card. Counts ONLY — the same union the
    // kiosk roster uses (Pandora waiverExpiry ∪ our Neon joins), with the names
    // dropped on the floor. That distinction is the whole point of this endpoint:
    // the link is forwardable to a whole party, so it must never carry a list of
    // who has and hasn't signed.
    const registered = (detail.persons_list || [])
      .map((p) => ({
        personId: String(p.personId ?? p.id ?? ""),
        displayName: makeDisplayName(p.firstName || "", p.name || ""),
      }))
      .filter((p) => p.personId && p.displayName);
    const pandoraLocationId =
      PANDORA_LOCATION_MAP[BMI_LOCATION_TO_PANDORA_KEY[locationId] ?? ""] ||
      PANDORA_DEFAULT_LOCATION_ID;
    const validFlags = await mapWithConcurrency(registered, WAIVER_CHECK_CONCURRENCY, (p) =>
      waiverValidNow(p.personId, pandoraLocationId),
    );
    const signed = unionValidWithJoins(registered, validFlags, joins).length;

    const total = detail.persons ?? 0;
    const body = JSON.stringify({
      ok: true,
      label,
      activity: activities.join(" · ") || null,
      whenLabel: formatWhen(detail.when),
      centerName: LOCATION_NAMES[locationId] ?? "",
      total,
      // Never claim more signed than registered — the join union can exceed the
      // BMI headcount when someone signs who was never added to the reservation.
      signed: Math.min(signed, total || signed),
    });
    redis.setex(cacheKey, CACHE_TTL_SECONDS, body).catch(() => {});
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": "application/json", "x-waiver-cache": "miss" },
    });
  } catch (err) {
    console.error("[waiver-context] error:", err);
    return NextResponse.json({ ok: false, error: "Failed to load reservation" }, { status: 502 });
  }
}
