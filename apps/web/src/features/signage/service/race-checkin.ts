import "server-only";

/**
 * What the track screens need that a browser cannot fetch for itself.
 *
 * The scene gets its session and its delay client-side from `useTrackStatus()` —
 * the same two endpoints the website and the e-tickets use, so a wall can never
 * disagree with the ticket in a guest's hand. This module supplies only the
 * remainder: whether anyone on the heat currently checking in is a VIP, and how
 * far through the roster the desk has got (that count comes from the shared
 * counter in ./checkin-progress, so every board in the building agrees).
 *
 * WHY THIS CANNOT COME FROM THE SCAN RAIL (owner, 2026-08-11): **VIPs do not
 * scan in.** They are met and escorted. So VIP presence has to be read off the
 * HEAT ROSTER — who is entered in the session — rather than from anybody
 * swiping a licence at the desk. Detecting it from scans would mean a VIP party
 * never triggers the banner that tells them where to go.
 *
 * Reads Redis directly rather than calling our own HTTP endpoints: the keys are
 * already warmed every minute by the check-in alerts cron, it avoids a
 * self-fetch, and it sidesteps the participants endpoint's browser PII gate
 * (which redacts the very names we need) by never leaving the server.
 */
import redis from "@/lib/redis";
import { vipComboPersonLegsOnDate } from "@/lib/bowling-db";
import { sessionCheckinCounts } from "./checkin-progress";
import type { TrackKey } from "../track";

/** Pandora location id for FastTrax — the only venue with tracks. */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

export interface RaceCheckinInfo {
  track: TrackKey;
  sessionId: number | null;
  /**
   * How the heat is NAMED on a wall — "Session 59", "Pro".
   *
   * Carried here, next to the sessionId the briefing send is keyed on, so the
   * "proceed to the red room" announcement can say WHICH session it is talking
   * to without re-reading a session from a separate client poll that may
   * already have rolled to the next heat.
   */
  heatNumber: number | null;
  raceType: string | null;
  /** Someone on the heat checking in right now is on a VIP combo today. */
  vipOnHeat: boolean;
  /** Their first names, for a personal greeting. Empty when we have none. */
  vipFirstNames: string[];
  /** Progress through the heat's roster. Null when it could not be read — the
   *  board shows nothing rather than a wrong count. */
  checkedIn: number | null;
  total: number | null;
}

export interface CachedRace {
  sessionId?: number;
  heatNumber?: number;
  raceType?: string;
  scheduledStart?: string;
}

interface CachedParticipant {
  personId?: string | number;
  firstName?: string;
  /** A TIMESTAMP, not a flag — see participantCheckedIn in ../checkin-progress.
   *  Typed `boolean` here once, which made the count below always zero. */
  checkedIn?: string | boolean | null;
}

/**
 * Read the session currently checking in on a track.
 *
 * `pandora:last-race:fasttrax:{track}` is written by /api/pandora/races-current
 * and deliberately OUTLIVES Pandora's own ~20-minute expiry, so the "now
 * checking in" line stays up between heats instead of blinking out.
 */
export async function currentSession(track: TrackKey): Promise<CachedRace | null> {
  try {
    const raw = await redis.get(`pandora:last-race:fasttrax:${track}`);
    return raw ? (JSON.parse(raw) as CachedRace) : null;
  } catch {
    return null;
  }
}

/** Roster for a session, from the cache the alerts cron keeps warm. */
async function roster(sessionId: number): Promise<CachedParticipant[]> {
  try {
    const raw = await redis.get(`pandora:participants:${FASTTRAX_LOCATION_ID}:${sessionId}:R1`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CachedParticipant[]) : [];
  } catch {
    return [];
  }
}

/**
 * Is a VIP party on the heat that is checking in on this track?
 *
 * Fails CLOSED on the banner: any error, missing cache or empty roster returns
 * `vipOnHeat: false`. Showing "head to the in-field" to a heat with no VIPs in
 * it would send ordinary racers to the wrong place, which is worse than a VIP
 * party not seeing the banner and asking a member of staff.
 */
export async function raceCheckinInfo(
  track: TrackKey,
  businessDate: string,
): Promise<RaceCheckinInfo> {
  const empty: RaceCheckinInfo = {
    track,
    sessionId: null,
    heatNumber: null,
    raceType: null,
    vipOnHeat: false,
    vipFirstNames: [],
    checkedIn: null,
    total: null,
  };

  // MEGA FALLBACK, and it is load-bearing for the send-clears-the-board flow.
  // A track board is scoped to blue or red, but on a Mega day the only warm
  // last-race key is `mega` — the scoped read returns null, this whole section
  // came back empty, and the board never received `briefedAtMs`, so sending a
  // group to a room cleared nothing (owner 2026-08-11, on a Mega night). The
  // physical board's question is "what is checking in HERE", and on a Mega day
  // the answer for both boards is the Mega session. Exact track first, so a
  // normal day never reads the stale mega key.
  const race = (await currentSession(track)) ?? (await currentSession("mega"));
  const sessionId = typeof race?.sessionId === "number" ? race.sessionId : null;
  if (sessionId == null) return empty;

  // "8 of 12 checked in" — the single most useful number on the board for the
  // staff member working the desk, and reassuring for a party watching their
  // group arrive.
  //
  // COUNTED BY THE SHARED COUNTER, not from the cached roster below, for two
  // reasons. It used to read `p.checkedIn === true` against a field Pandora
  // sends as a TIMESTAMP STRING, so this board reported 0 of N for every heat
  // it ever showed. And the roster cache stops being warmed once a heat has
  // been alerted on — while staff are still scanning — so a number taken from
  // it freezes mid-group. sessionCheckinCounts reads live and memoises, so the
  // track board and the briefing-room camera boards cannot disagree about the
  // same heat.
  //
  // The cached roster is still read, in parallel, for the VIP names: those need
  // personIds and first names, which the count does not.
  const [people, counts] = await Promise.all([
    roster(sessionId),
    sessionCheckinCounts(String(sessionId), Date.now()).catch(() => null),
  ]);
  const counted = {
    ...empty,
    sessionId,
    // From the SAME record the sessionId came from — the heat's name and the id
    // the briefing send is keyed on can never describe two different heats.
    heatNumber: typeof race?.heatNumber === "number" ? race.heatNumber : null,
    raceType: race?.raceType?.trim() || null,
    checkedIn: counts?.checkedIn ?? null,
    total: counts?.total ?? null,
  };
  if (people.length === 0) return counted;

  // personIds stay STRINGS end to end — BMI ids exceed Number.MAX_SAFE_INTEGER
  // and Number()/JSON round-tripping them is this repo's classic off-by-one.
  const byPersonId = new Map<string, CachedParticipant>();
  for (const p of people) {
    const id = p.personId == null ? "" : String(p.personId);
    if (/^\d+$/.test(id)) byPersonId.set(id, p);
  }
  if (byPersonId.size === 0) return counted;

  try {
    const vips = await vipComboPersonLegsOnDate(Array.from(byPersonId.keys()), businessDate);
    if (vips.size === 0) return counted;

    const names: string[] = [];
    for (const personId of vips.keys()) {
      const first = byPersonId.get(personId)?.firstName?.trim();
      // First names only — this goes on a public wall.
      if (first) names.push(first.split(/\s+/)[0]);
    }
    return { ...counted, vipOnHeat: true, vipFirstNames: Array.from(new Set(names)) };
  } catch {
    return counted;
  }
}
