import type { NextRequest } from "next/server";
import redis from "@/lib/redis";

/**
 * Back-to-back race detection for the racing check-in scanner.
 *
 * "Back-to-back" = the racer being checked in races again within the NEXT 2
 * heats counted across ALL tracks (owner decision 2026-07-10): merge today's
 * blue/red/mega schedules sorted by scheduledStart, take the 2 heats that
 * start soonest after the one being checked into, and flag if the racer is on
 * either roster. Scheduled grid, not live-delay-adjusted — delays shift all
 * heats together so the relative "next 2" ordering holds.
 *
 * Fail-open everywhere: schedule fetch failure, cold roster cache, Pandora
 * timeout → null (no banner), never a blocked or slowed-to-death check-in.
 */

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

// Pandora resource name → the lowercase track key the scanner UI colors by.
const TRACK_RESOURCES = [
  { resourceName: "Blue Track", track: "blue" },
  { resourceName: "Red Track", track: "red" },
  { resourceName: "Mega Track", track: "mega" },
] as const;

function pandoraHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
    Accept: "application/json",
  };
}

/** One heat on today's merged cross-track schedule. */
export interface HeatCandidate {
  sessionId: string;
  track: string;
  raceType: string | null;
  heatNumber: number | null;
  scheduledStart: string;
}

export interface BackToBackRace {
  track: string | null;
  raceType: string | null;
  heatNumber: number | null;
  scheduledStart: string | null;
}

/**
 * The next 2 heats (any track) strictly after the heat being checked into.
 * Pure — exported for the check-in self-test. Anchors on the CURRENT heat's
 * scheduledStart (from races-current) rather than requiring the current
 * session to appear in the schedule list, so a stale schedule cache that's
 * missing the current heat still yields the right candidates.
 */
export function pickNextTwoHeats(
  sessions: HeatCandidate[],
  currentSessionId: string,
  currentScheduledStart: string,
): HeatCandidate[] {
  const anchor = Date.parse(currentScheduledStart);
  if (Number.isNaN(anchor)) return [];
  return sessions
    .filter((s) => s.sessionId && s.sessionId !== currentSessionId)
    .map((s) => ({ s, t: Date.parse(s.scheduledStart) }))
    .filter(({ t }) => !Number.isNaN(t) && t > anchor)
    .sort((a, b) => a.t - b.t)
    .slice(0, 2)
    .map(({ s }) => s);
}

/** Today's schedule for one track via the cron-warmed sessions proxy. */
async function fetchTrackHeats(
  origin: string,
  resourceName: string,
  track: string,
  ymd: string,
): Promise<HeatCandidate[]> {
  try {
    const qs = new URLSearchParams({
      locationId: FASTTRAX_LOCATION_ID,
      resourceName,
      startDate: `${ymd}T00:00:00`,
      endDate: `${ymd}T23:59:59`,
      // Cache-first (cron-warmed), falls through to live on miss — same
      // trade-off as the arena schedule lookup in the check-in route.
      prefer: "cache",
    }).toString();
    const res = await fetch(`${origin}/api/pandora/sessions?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    return list.map(
      (s: {
        sessionId?: string | number;
        type?: string;
        heatNumber?: number;
        scheduledStart?: string;
      }) => ({
        sessionId: String(s.sessionId ?? ""),
        track,
        raceType: s.type ?? null,
        heatNumber: s.heatNumber ?? null,
        scheduledStart: s.scheduledStart ?? "",
      }),
    );
  } catch {
    return [];
  }
}

interface RosterRow {
  personId?: string | number | null;
  participantId?: string | number | null;
}

/** Heat roster — Redis (cron-warmed) first, live Pandora on miss. */
async function fetchRoster(sessionId: string): Promise<RosterRow[]> {
  try {
    const cached = await redis.get(`pandora:participants:${FASTTRAX_LOCATION_ID}:${sessionId}:R1`);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed as RosterRow[];
    }
  } catch {
    /* fall through to live */
  }
  try {
    const res = await fetch(
      `${PANDORA_BASE}/v2/bmi/session/${FASTTRAX_LOCATION_ID}/${sessionId}/participants?excludeRemoved=true`,
      { headers: pandoraHeaders(), cache: "no-store", signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? (json.data as RosterRow[]) : [];
  } catch {
    return [];
  }
}

function rosterHasRacer(
  roster: RosterRow[],
  personId: string,
  participantId: string | null,
): boolean {
  return roster.some((p) => {
    if (participantId && p.participantId != null && String(p.participantId) === participantId) {
      return true;
    }
    return p.personId != null && String(p.personId) === personId;
  });
}

/**
 * Does `birthdate` (any string starting "YYYY-MM-DD") fall on `todayYmd`'s
 * month/day? Pure — exported for the check-in self-test. Feb 29 birthdays
 * match Feb 28 in non-leap years so leap-day guests still get their badge.
 */
export function birthdayMatchesToday(
  birthdate: string | null | undefined,
  todayYmd: string,
): boolean {
  const born = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthdate ?? "");
  const today = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayYmd);
  if (!born || !today) return false;
  const [, , bMonth, bDay] = born;
  const [, tYear, tMonth, tDay] = today;
  if (bMonth === tMonth && bDay === tDay) return true;
  if (bMonth === "02" && bDay === "29" && tMonth === "02" && tDay === "28") {
    const y = Number(tYear);
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return !isLeap;
  }
  return false;
}

/**
 * Is today (ET) the guest's birthday? Reads the BMI person record via
 * Pandora (the same GET the waiver check uses — carries `birthdate`).
 * Fail-open: missing birthdate, timeout, or any error → false.
 */
export async function fetchIsBirthdayToday(personId: string, todayYmd: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${PANDORA_BASE}/v2/bmi/person/${FASTTRAX_LOCATION_ID}/${personId}?picture=false&allRelated=false`,
      { headers: pandoraHeaders(), cache: "no-store", signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return false;
    const json = await res.json();
    const birthdate = json?.data?.birthdate;
    return typeof birthdate === "string" && birthdayMatchesToday(birthdate, todayYmd);
  } catch {
    return false;
  }
}

/**
 * Is the racer being checked into `sessionId` also on one of the next 2 heats
 * (any track)? Returns that heat's details for the banner, or null.
 */
export async function findBackToBackRace(
  req: NextRequest,
  opts: {
    sessionId: string;
    /** Current heat's scheduledStart from races-current. */
    scheduledStart: string;
    /** BMI personId as a STRING (never Number() a BMI id). */
    personId: string;
    /** Stable participantId off a 4-part e-ticket QR, when present. */
    participantId: string | null;
  },
): Promise<BackToBackRace | null> {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const perTrack = await Promise.all(
      TRACK_RESOURCES.map((t) => fetchTrackHeats(req.nextUrl.origin, t.resourceName, t.track, ymd)),
    );
    const candidates = pickNextTwoHeats(perTrack.flat(), opts.sessionId, opts.scheduledStart);
    if (candidates.length === 0) return null;

    // Both rosters in parallel; the SOONER candidate wins if the racer is on both.
    const rosters = await Promise.all(candidates.map((c) => fetchRoster(c.sessionId)));
    for (let i = 0; i < candidates.length; i++) {
      if (rosterHasRacer(rosters[i], opts.personId, opts.participantId)) {
        const c = candidates[i];
        return {
          track: c.track,
          raceType: c.raceType,
          heatNumber: c.heatNumber,
          scheduledStart: c.scheduledStart || null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
