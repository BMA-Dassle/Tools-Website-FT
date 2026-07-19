import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { displayNameFromFull } from "@/lib/display-name";
import { listDailyEvents } from "~/features/daily-events/service";
import type { Reservation } from "~/features/daily-events/types";
import { isWaiverEvent } from "~/features/daily-events/logic";
import { todayET } from "~/features/daily-events/format";
import { CENTER_TO_BMI_LOCATION_IDS, isValidCenter } from "~/features/kiosk/waiver/locations";
import type { KioskWaiverReservationItem } from "~/features/kiosk/waiver/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/kiosk/waiver/reservations?center=fort-myers|naples
 *
 * Kiosk group-waiver reservation picker: today's online + group reservations
 * with a waiver-required activity, starting within the next 2 hours (or in
 * progress), sorted by time. No auth (kiosk-route posture, like
 * /api/kiosk/device) — the payload is PII-LEAN BY CONSTRUCTION: labels are
 * formatted server-side (event name, else main contact as "First L."); full
 * names, emails and phones never reach the kiosk browser.
 *
 * Perf: reads the SAME `de:res:{loc}:{date}:0` Redis keys the daily-events
 * cache-warm cron re-warms every 5 minutes (TTL 360s), so a polling kiosk
 * costs ~0 BMI calls; a shaped second-level cache (60s) absorbs multi-kiosk
 * fan-out. Redis outage is non-fatal — falls through to BMI.
 */

const DE_CACHE_TTL_SECONDS = 360; // matches the admin route + warm cron
const SHAPED_CACHE_TTL_SECONDS = 60;
const WINDOW_MINUTES = 120;

/** Naive ET wall-clock stamp ("YYYY-MM-DDTHH:mm:ss") for an epoch — BMI
 *  when/stop strings are naive ET, so window math compares in that space. */
function etNaiveStamp(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(epochMs);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA hour12:false can emit "24" at midnight — normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

function fmtTime12(naiveIso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(naiveIso);
  if (!m) return "";
  const h = Number(m[1]);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${ampm}`;
}

async function listForLocation(locationId: number, date: string): Promise<Reservation[]> {
  const cacheKey = `de:res:${locationId}:${date}:0`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (typeof cached === "string" && cached) {
    try {
      const parsed = JSON.parse(cached) as { data?: { reservations?: Reservation[] } };
      if (Array.isArray(parsed?.data?.reservations)) return parsed.data.reservations;
    } catch {
      /* fall through to live fetch */
    }
  }
  const data = await listDailyEvents(locationId, date, false);
  // Same key + shape as the admin route so kiosk, cron and board share one cache.
  redis
    .setex(cacheKey, DE_CACHE_TTL_SECONDS, JSON.stringify({ success: true, data }))
    .catch(() => {});
  return data.reservations;
}

export async function GET(req: NextRequest) {
  const center = req.nextUrl.searchParams.get("center") ?? "";
  if (!isValidCenter(center)) {
    return NextResponse.json({ success: false, error: "Invalid center" }, { status: 400 });
  }

  const shapedKey = `kiosk:waiver:res:${center}`;
  const shaped = await redis.get(shapedKey).catch(() => null);
  if (typeof shaped === "string" && shaped) {
    return new NextResponse(shaped, {
      status: 200,
      headers: { "content-type": "application/json", "x-kiosk-cache": "hit" },
    });
  }

  try {
    const date = todayET();
    const locationIds = CENTER_TO_BMI_LOCATION_IDS[center];
    const perLocation = await Promise.all(
      locationIds.map(async (loc) => ({ loc, reservations: await listForLocation(loc, date) })),
    );

    const nowMs = Date.now();
    const nowEt = etNaiveStamp(nowMs);
    const horizonEt = etNaiveStamp(nowMs + WINDOW_MINUTES * 60_000);

    // Union across the shared-server FM locations — the same project can appear
    // in both queries; first occurrence wins (list order = CENTER_TO_BMI order).
    const seen = new Set<string>();
    const items: KioskWaiverReservationItem[] = [];
    for (const { loc, reservations } of perLocation) {
      for (const r of reservations) {
        if (!r.id || seen.has(r.id)) continue;
        if (!r.when) continue;
        if ((r.state || "").toLowerCase().includes("cancel")) continue;
        if (!isWaiverEvent(r)) continue;
        // Window: starts within the next 2 hours, or already started and not
        // yet ended (schedule-less projects have no stop → drop at start time).
        const upcoming = r.when >= nowEt && r.when <= horizonEt;
        const inProgress = r.when < nowEt && !!r.stop && r.stop > nowEt;
        if (!upcoming && !inProgress) continue;
        seen.add(r.id);
        const isOnline = (r.kind || "").toLowerCase().includes("online");
        // Group functions: proj.name is a real event name ("Aiden Birthday
        // Party") — use it. Online reservations: BMI stuffs the guest's FULL
        // name into proj.name (live 2026-07-18: name="Ross Gallagher"), so
        // ALWAYS reduce online labels to "First L." — full names never reach
        // the kiosk browser.
        let label: string;
        if (isOnline) {
          const source = (r.personName || "").trim() || (r.name || "").trim();
          label =
            !source || source.toLowerCase() === "online"
              ? "Online reservation"
              : displayNameFromFull(source);
        } else {
          label = (r.name || "").trim() || displayNameFromFull(r.personName) || "Reservation";
        }
        items.push({
          projectId: r.id,
          locationId: loc,
          label,
          startIso: r.when,
          stopIso: r.stop || "",
          timeLabel: fmtTime12(r.when),
          persons: r.persons || 0,
          registeredPersons: r.registeredPersons ?? null,
          kind: isOnline ? "online" : "group",
        });
      }
    }
    items.sort((a, b) => a.startIso.localeCompare(b.startIso));

    const body = JSON.stringify({ success: true, reservations: items });
    redis.setex(shapedKey, SHAPED_CACHE_TTL_SECONDS, body).catch(() => {});
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": "application/json", "x-kiosk-cache": "miss" },
    });
  } catch (error) {
    console.error("[kiosk-waiver] reservations error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load reservations" },
      { status: 502 },
    );
  }
}
