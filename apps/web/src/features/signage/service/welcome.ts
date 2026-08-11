import "server-only";

/**
 * Today's parties, and where each one goes first.
 *
 * SCOPE (owner): EVENTS ONLY — birthday parties and contracted group functions.
 * Not general open-play reservations. The board is a marquee for people who
 * booked an occasion, not a list of everyone in the building.
 *
 * TWO SOURCES, JOINED ON THE BMI PROJECT ID:
 *   - Neon `group_function_quotes` — who they are, how many, which center.
 *   - BMI day planner (via the daily-events service, served from the Redis
 *     cache a cron keeps warm) — WHICH ATTRACTION they start on and when.
 * The itinerary genuinely only exists in BMI; nothing persists it locally, so
 * the join is unavoidable. It is cheap because the cache is already warm.
 *
 * THE ID IS A STRING AND STAYS ONE. `bmi_reservation_id` is a 17-digit BMI
 * project id; Number()/JSON round-tripping it is this repo's classic
 * off-by-one. It is compared as text, never parsed.
 *
 * PII: first names only. This is a public wall in a lobby.
 */
import { listQuotesByEventDates, type GroupFunctionQuote } from "@/lib/group-function-db";
import { listDailyEvents } from "~/features/daily-events/service";
import type { Reservation } from "~/features/daily-events/types";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
import { VENUE_INFO, type SignageVenue } from "../constants";
import type { WelcomeEntry } from "../types";

/** Statuses that are not a real, still-happening event. */
const DEAD_STATUSES = new Set(["cancelled", "denied", "expired", "pending", "pending_approval"]);

export interface WelcomeWindow {
  /** Show a party from this many minutes before its first leg. */
  leadMins: number;
  /** …until this many minutes after it has started. */
  trailMins: number;
}

/**
 * Build the welcome board for a venue.
 *
 * Returns `null` — not `[]` — when the day's data could not be read at all.
 * The difference matters: `[]` means "nothing on today" and lets the scene be
 * skipped cleanly, while `null` means "we could not ask", and the rotation
 * treats those differently.
 */
export async function buildWelcomeBoard(
  venue: SignageVenue,
  centerCodes: string[],
  ymd: string,
  window: WelcomeWindow,
  nowMs: number,
): Promise<WelcomeEntry[] | null> {
  let quotes: GroupFunctionQuote[];
  try {
    quotes = await listQuotesByEventDates([ymd], centerCodes);
  } catch {
    return null;
  }

  const live = quotes.filter((q) => !DEAD_STATUSES.has(String(q.status ?? "").toLowerCase()));
  if (live.length === 0) return [];

  // Itineraries are a best-effort enrichment: if BMI is unreachable we still
  // welcome the party, just without naming their first stop. A greeting with
  // no directions beats no greeting.
  const byProjectId = await firstLegsByProject(venue, ymd);

  const entries: WelcomeEntry[] = [];
  for (const q of live) {
    const projectId = String(q.bmi_reservation_id ?? "");
    const leg = projectId ? byProjectId.get(projectId) : undefined;

    const startIso = leg?.startIso ?? isoOrNull(q.event_date);
    if (!withinWindow(startIso, nowMs, window)) continue;

    entries.push({
      id: projectId || `gf-${q.id}`,
      title: displayTitle(q),
      guestCount: numOrNull(q.guest_count),
      firstStopLabel: leg?.label ?? null,
      building: leg?.building ?? VENUE_INFO[venue].label,
      startsAtIso: startIso,
      startsAtLabel: startIso ? fmtTime(startIso) : null,
      isVip: /\bvip\b/i.test(String(q.event_name ?? "")),
    });
  }

  entries.sort((a, b) => (a.startsAtIso ?? "").localeCompare(b.startsAtIso ?? ""));
  return entries;
}

/* ── first legs from BMI ──────────────────────────────────────────────── */

interface FirstLeg {
  startIso: string | null;
  /** "First up: Bowling — HP VIP Lanes" */
  label: string;
  building: string;
}

/**
 * Earliest scheduled resource per BMI project, for today at this venue.
 *
 * Fort Myers is two venues sharing one campus (FastTrax and HeadPinz), so a
 * party's first stop can be in the *other* building — which is exactly the
 * thing a welcome board has to tell them. Both FM location ids are queried and
 * the building is reported from whichever one the leg is actually on.
 */
async function firstLegsByProject(
  venue: SignageVenue,
  ymd: string,
): Promise<Map<string, FirstLeg>> {
  const out = new Map<string, FirstLeg>();
  const info = VENUE_INFO[venue];
  const locationIds =
    info.center === "fort-myers"
      ? [VENUE_INFO.HPFM.bmiLocationId, VENUE_INFO.FT.bmiLocationId]
      : [info.bmiLocationId];

  const results = await Promise.all(
    locationIds.map(async (locationId) => {
      try {
        const res = await listDailyEvents(locationId, ymd);
        return { locationId, reservations: res.reservations ?? [] };
      } catch {
        return { locationId, reservations: [] as Reservation[] };
      }
    }),
  );

  for (const { locationId, reservations } of results) {
    const building = buildingFor(locationId);
    for (const r of reservations) {
      const projectId = String(r.id ?? "");
      if (!projectId) continue;
      const startIso = r.when || null;
      const prev = out.get(projectId);
      // Keep the EARLIEST leg across both buildings — that is the first stop.
      if (prev && prev.startIso && startIso && prev.startIso <= startIso) continue;
      const resource = r.resourceName || r.allResourceNames?.[0] || "";
      out.set(projectId, {
        startIso,
        label: resource ? `First up: ${resource}` : "First up: see the front desk",
        building,
      });
    }
  }
  return out;
}

function buildingFor(locationId: number): string {
  if (locationId === VENUE_INFO.FT.bmiLocationId) return VENUE_INFO.FT.label;
  if (locationId === VENUE_INFO.HPN.bmiLocationId) return VENUE_INFO.HPN.label;
  return VENUE_INFO.HPFM.label;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/**
 * What the wall calls this party.
 *
 * First names only (owner) — never a surname on a public screen. The stored
 * `event_name` has already been cleaned of venue prefixes and dates at ingest,
 * but it can still carry a full name, so the contact's first name is preferred
 * and the event name is only used when it clearly is not a person's name.
 */
function displayTitle(q: GroupFunctionQuote): string {
  const first = String(q.guest_first_name ?? "")
    .trim()
    .split(/\s+/)[0];
  if (first) return `${first}'s Party`;
  const name = String(q.event_name ?? "").trim();
  return name || "Welcome!";
}

function withinWindow(iso: string | null, nowMs: number, w: WelcomeWindow): boolean {
  if (!iso) return true; // no time known — show it rather than hide the party
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  const mins = (t - nowMs) / 60_000;
  return mins <= w.leadMins && mins >= -w.trailMins;
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const s = typeof v === "string" ? v : String(v);
  return Number.isFinite(Date.parse(s)) ? s : null;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * TIME RULE (lesson 51a47370). Two shapes arrive here and only one helper is
 * safe for both: BMI day-planner starts are NAIVE ET wall-clock (no zone), while
 * Neon's event_date is a Z-stamped TIMESTAMPTZ. `new Date(x)` + a
 * timeZone re-convert double-shifts the first and is the four-hour error that
 * put "7:00 AM" on a wall for an 11:00 AM opening. toEtWallClock normalizes,
 * fmtTime12 renders the wall-clock as written.
 */
function fmtTime(iso: string): string {
  return fmtTime12(toEtWallClock(iso));
}
