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
const COUNT_CACHE_TTL_SECONDS = 60;
/**
 * The signed count costs one Pandora read per REGISTERED person (concurrency 5),
 * and real group events are big — the 2026-12-18 Fireservice event has 100. That
 * is ~20 sequential rounds inside the request that draws the event header, so it
 * gets a hard deadline: the header (name + when) must never wait on a count.
 *
 * Missing the deadline is not a failure. The per-person results are cached as they
 * land, so the sweep keeps warming and a later load shows the number. The count is
 * cached separately from the summary for exactly this reason — a slow count must
 * not poison the summary's cache entry with a permanently absent `signed`.
 */
const COUNT_DEADLINE_MS = 2_500;

/** Resolve to undefined rather than hang past `ms`. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

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
  const countKey = `waiver:ctx:signed:${locationId}:${projectId}`;
  const [cached, cachedCount] = await Promise.all([
    redis.get(cacheKey).catch(() => null),
    redis.get(countKey).catch(() => null),
  ]);
  const cachedSigned =
    typeof cachedCount === "string" && /^\d+$/.test(cachedCount) ? Number(cachedCount) : undefined;

  if (typeof cached === "string" && cached) {
    // Summary is cached; merge in whatever the count cache knows right now. A
    // fresh count can appear on a later load without re-fetching the summary.
    const summary = JSON.parse(cached) as Record<string, unknown>;
    if (cachedSigned !== undefined) summary.signed = cachedSigned;
    return new NextResponse(JSON.stringify(summary), {
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
    const total = detail.persons ?? 0;

    // The summary is what the header needs; it is cached on its own so a slow
    // count can never keep the event name and date off the screen.
    const summary = {
      ok: true,
      label,
      activity: activities.join(" · ") || null,
      whenLabel: formatWhen(detail.when),
      centerName: LOCATION_NAMES[locationId] ?? "",
      total,
    };
    redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(summary)).catch(() => {});

    let signed = cachedSigned;
    if (signed === undefined) {
      const counted = await withDeadline(
        mapWithConcurrency(registered, WAIVER_CHECK_CONCURRENCY, (p) =>
          waiverValidNow(p.personId, pandoraLocationId),
        ).then((flags) => unionValidWithJoins(registered, flags, joins).length),
        COUNT_DEADLINE_MS,
      );
      if (counted !== undefined) {
        // Never claim more signed than registered — the join union can exceed the
        // BMI headcount when someone signs who was never added to the reservation.
        signed = Math.min(counted, total || counted);
        redis.setex(countKey, COUNT_CACHE_TTL_SECONDS, String(signed)).catch(() => {});
      }
    }

    // `signed` is OMITTED when the count didn't land in time — the card then shows
    // "100 registered" with no fraction, rather than a confident, wrong "0 of 100".
    return new NextResponse(
      JSON.stringify(signed === undefined ? summary : { ...summary, signed }),
      {
        status: 200,
        headers: { "content-type": "application/json", "x-waiver-cache": "miss" },
      },
    );
  } catch (err) {
    console.error("[waiver-context] error:", err);
    return NextResponse.json({ ok: false, error: "Failed to load reservation" }, { status: 502 });
  }
}
