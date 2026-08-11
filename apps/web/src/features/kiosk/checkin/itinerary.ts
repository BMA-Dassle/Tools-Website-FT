/**
 * Pure "what's next" itinerary assembler for kiosk check-in.
 *
 * Ported from the v2 confirmation page's activity model (app/book/confirmation/
 * v2/page.tsx:1407-1518): racing collapses to ONE activity (earliest heat),
 * each attraction and each bowling leg is its own, sorted by start time; the
 * earliest is the "Start here · First stop".
 *
 * TIME RULE (kiosk hard rule / lesson 51a47370): BMI heat/slot starts are naive
 * ET wall-clock (no zone); bowling bookedAt carries ET's own offset. In BOTH
 * cases the HH:mm in the string IS the ET wall-clock, so we format by stripping
 * the zone and rendering the wall-clock components as UTC — never by
 * `new Date(iso)` (server-TZ) or a `America/New_York` re-convert (double shift).
 * Kept pure (string-in, string-out; no Date-from-iso, no I/O) so it is
 * TZ-independent on the server and unit-testable.
 */
import type { CheckinActivity } from "./types";

/** Strip a trailing Z or ±HH:mm offset — leaves the naive wall-clock text. */
function stripZone(iso: string): string {
  return iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
}

/**
 * Normalize any timestamp to an ET wall-clock naive string
 * ("YYYY-MM-DDTHH:mm:ss"). Neon TIMESTAMPTZ serializes as a UTC `.toISOString()`
 * (trailing Z) — rendering that as wall-clock would show 17:30Z as 5:30 PM
 * instead of the true 1:30 PM (the documented 51a47370 4h-off bug). A value
 * that is ALREADY naive ET (BMI heat/slot strings) passes through unchanged.
 * An ET-offset stamp (…-04:00) also passes through — its HH:mm is already ET.
 */
export function toEtWallClock(iso: string | null | undefined): string {
  if (!iso) return "";
  if (!/Z$/.test(iso)) return iso; // naive, or ET-offset whose wall-clock is ET
  const d = new Date(iso);
  if (isNaN(d.getTime())) return stripZone(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${hh}:${g("minute")}:${g("second")}`;
}

/** Sort/compare key: tz-stripped minute ("YYYY-MM-DDTHH:mm"). */
export function timeKey(iso: string | null | undefined): string {
  return iso ? stripZone(iso).slice(0, 16) : "";
}

/** Parse the naive wall-clock components into a UTC Date (TZ-neutral math). */
function wallClockUtc(iso: string): Date | null {
  const clean = stripZone(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(clean);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0));
}

/** 12-hour label ("4:12 PM") from a naive/offset ET wall-clock string. */
export function fmtTime12(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = wallClockUtc(iso);
  if (!d) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

/** "Arrive by 3:42 PM" style label — wall-clock minus `minsBefore`. */
export function fmtArriveBy(iso: string | null | undefined, minsBefore: number): string | null {
  if (!iso) return null;
  const d = wallClockUtc(iso);
  if (!d) return null;
  d.setUTCMinutes(d.getUTCMinutes() - minsBefore);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

export interface RacerLite {
  name: string;
  /** identified = has a BMI personId bound to the heat. */
  identified: boolean;
  /** waiverValid = Pandora shows a current waiver (pulled in from the project). */
  waiverValid: boolean;
}
export interface RaceInput {
  startIso: string;
  title: string; // "Race 1 · Blue Track"
  racers: RacerLite[];
}
export interface AttractionInput {
  slug: string;
  startIso: string;
  qtyPaid: number;
  readyCount: number;
}
export interface BowlingInput {
  kind: "bowling" | "kbf";
  startIso: string;
  playerCount: number;
  laneLabel?: string;
  neonReservationId?: number;
}
export interface AttractionMeta {
  name: string;
  building: string;
}

export interface ItineraryInput {
  racing: RaceInput | null;
  attractions: AttractionInput[];
  bowling: BowlingInput[];
  /** slug → display meta (from ATTRACTIONS on the server). */
  meta: (slug: string) => AttractionMeta | null;
  racingBuilding: string;
  bowlingBuilding: string;
}

/** Racing check-in opens this many minutes before the heat. Exported because
 *  the lobby-TV track screens tell guests the same number, and a wall that
 *  disagrees with the itinerary a guest was handed is worse than no wall. */
export const RACING_CHECKIN_LEAD_MIN = 30;

/**
 * Assemble the sorted activity list + the first-stop card. Racing is one
 * activity; each attraction/bowling leg its own; sort on the tz-stripped
 * minute so mixed naive/offset starts compare correctly.
 */
export function assembleItinerary(input: ItineraryInput): {
  activities: CheckinActivity[];
  firstStop: { building: string; arriveByLabel: string | null } | null;
} {
  const activities: CheckinActivity[] = [];

  if (input.racing) {
    // Ready = identified AND holding a current waiver (the pulled-in project
    // waivers). An identified racer with an expired/missing waiver is not ready.
    const readyCount = input.racing.racers.filter((r) => r.identified && r.waiverValid).length;
    activities.push({
      kind: "racing",
      startIso: input.racing.startIso || null,
      timeLabel: fmtTime12(input.racing.startIso),
      title: input.racing.title || "Racing",
      building: input.racingBuilding,
      slug: "racing",
      readyCount,
      totalCount: input.racing.racers.length,
    });
  }

  for (const a of input.attractions) {
    const m = input.meta(a.slug);
    activities.push({
      kind: "attraction",
      startIso: a.startIso || null,
      timeLabel: fmtTime12(a.startIso),
      title: m?.name ?? "Activity",
      building: m?.building ?? "",
      slug: a.slug,
      readyCount: a.readyCount,
      totalCount: a.qtyPaid,
    });
  }

  for (const b of input.bowling) {
    activities.push({
      kind: "bowling",
      startIso: b.startIso || null,
      timeLabel: fmtTime12(b.startIso),
      title: b.kind === "kbf" ? "Kids Bowl Free" : "Bowling",
      building: input.bowlingBuilding,
      slug: b.kind === "kbf" ? "kids-bowl-free" : "bowling",
      readyCount: 0,
      totalCount: b.playerCount,
      laneLabel: b.laneLabel,
      neonReservationId: b.neonReservationId,
    });
  }

  activities.sort((a, b) => timeKey(a.startIso).localeCompare(timeKey(b.startIso)));

  const first = activities[0] ?? null;
  const firstStop = first
    ? {
        building: first.building || "the front desk",
        // Racing check-in opens 30 min early; other activities show start time.
        arriveByLabel:
          first.kind === "racing" && first.startIso
            ? fmtArriveBy(first.startIso, RACING_CHECKIN_LEAD_MIN)
            : first.timeLabel || null,
      }
    : null;

  return { activities, firstStop };
}
