import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { parseCheckinQr } from "@/lib/qr-checkin";
import { parseMemberQr, parseMemberCode } from "~/features/kiosk/qr-scanner/member-qr";
import { lookupMemberMatches, lookupMemberMatchesAt } from "~/features/kiosk/license/lookup.server";
import { getRacerPass } from "~/features/racing/data/racer-wallet-db";
import { recordSignageEvent } from "~/features/signage/events.server";
import { trackFromName, TRACK_RESOURCE_IDS } from "~/features/signage/track";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
import {
  getDepositOverview,
  addDeposit,
  DEPOSIT_KIND,
  type DepositOverviewRow,
} from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import { isVipComboPersonOnDate } from "@/lib/bowling-db";
import {
  birthdayMatchesToday,
  fetchIsBirthdayToday,
  findBackToBackRace,
  pickNextTwoHeats,
  type HeatCandidate,
} from "@/lib/checkin-race-flags";
import { ARENA_RESOURCES, HP_NAPLES_LOCATION_ID } from "~/features/arena-tickets/constants";
import { activeArenaCenters, type ArenaCenter } from "~/features/arena-tickets/centers";
import { calledArenaSessions } from "~/features/arena-tickets/sessions-current.server";
import { activityDisplay, classifyArenaSession } from "~/features/arena-tickets/types";
import { loadAllFromRedis, refreshRacesCurrent } from "~/features/racing/races-current.server";
import type { Participant as RosterParticipant } from "@/lib/participant-contact";
import {
  dropNullParticipants,
  participantsCacheKey,
  PARTICIPANTS_CACHE_TTL_SEC,
  rosterIsWorthCaching,
  rosterUpstreamQuery,
} from "~/features/racing/session-roster.server";
import {
  applyLocalFloor,
  parseStoredRoster,
  resolveRosterCount,
  rosterIsFreshForWire,
  type RosterCount,
} from "~/features/racing/roster-count";
import { BRIDGE_STALE_MS } from "~/features/racing/roster-dirty";
import { readRosterMarks, bankRosterRead } from "~/features/racing/roster-dirty.server";
import {
  recordScan,
  readScanHistory,
  summariseScans,
  type ScanKind,
  type ScanOutcome,
} from "~/features/checkin/scan-history";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const HEADSOCK_DEPOSIT_KIND_ID = DEPOSIT_KIND.HEADSOCK;

/** SMS-Timing client key for the Naples Office DB (its own BMI server —
 *  personIds from it must never be matched against FM sessions). Same
 *  literal bmi-office-actions keys its Naples config on. */
const NAPLES_CLIENT_KEY = "headpinznaples";

function pandoraHeaders(): HeadersInit {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

interface Participant {
  personId: string | number;
  participantId?: string | number | null;
  firstName: string;
  lastName: string;
  email?: string | null;
  viewpointCredit?: number | null;
}

/** "Blue Pro at 8:15" — pre-formatted, so a wall never does timezone maths to
 *  tell somebody where to be. */
function formatHeatLabel(
  track: string | null,
  raceType: string | null,
  scheduledStart: string | null,
): string | undefined {
  // Naive ET wall-clock (lesson 51a47370) — never new Date() + a timeZone
  // re-convert, which shifts it by the UTC offset.
  const time = scheduledStart ? fmtTime12(toEtWallClock(scheduledStart)) : "";
  const parts = [track, raceType].filter(Boolean).join(" ");
  if (!parts && !time) return undefined;
  return time ? `${parts} at ${time}`.trim() : parts;
}

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function auth(req: NextRequest): Promise<boolean> {
  return isAdminApiRequest(req);
}

async function lookupGuest(
  sessionId: string,
  personId: string,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<{
  participant: Participant | null;
  track: string | null;
  raceType: string | null;
  heatNumber: number | null;
}> {
  const cacheKey = `pandora:participants:${locationId}:${sessionId}:R1`;
  const cached = await redis.get(cacheKey);
  if (!cached) return { participant: null, track: null, raceType: null, heatNumber: null };

  let participants: Participant[];
  try {
    participants = JSON.parse(cached) as Participant[];
  } catch {
    return { participant: null, track: null, raceType: null, heatNumber: null };
  }

  const match = participants.find((p) => String(p.personId) === personId);

  // Track/raceType/heatNumber aren't on the participant object — we get them
  // from the races-current response in the caller. Return null here; the
  // caller will fill them from races-current or the session metadata.
  return {
    participant: match ?? null,
    track: null,
    raceType: null,
    heatNumber: null,
  };
}

async function lookupByParticipantId(
  sessionId: string,
  participateId: string,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<Participant | null> {
  const cacheKey = `pandora:participants:${locationId}:${sessionId}:R1`;
  const cached = await redis.get(cacheKey);
  if (!cached) return null;
  let participants: Participant[];
  try {
    participants = JSON.parse(cached) as Participant[];
  } catch {
    return null;
  }
  return (
    participants.find((p) => p.participantId && String(p.participantId) === participateId) ?? null
  );
}

interface CurrentRaces {
  blue?: {
    sessionId?: number | string;
    trackName?: string;
    raceType?: string;
    heatNumber?: number;
    scheduledStart?: string;
  } | null;
  red?: {
    sessionId?: number | string;
    trackName?: string;
    raceType?: string;
    heatNumber?: number;
    scheduledStart?: string;
  } | null;
  mega?: {
    sessionId?: number | string;
    trackName?: string;
    raceType?: string;
    heatNumber?: number;
    scheduledStart?: string;
  } | null;
}

/**
 * WHICH HEATS ARE CALLED — read through the warm carry, not a live Pandora call.
 *
 * This used to hit the bare `/api/pandora/races-current` URL, which is that
 * route's LIVE path: one Pandora read per call, a 9s upstream timeout, and only
 * then a fall back to the Redis carry. On 2026-08-18 Pandora was hanging past
 * 15s on more than half of those reads, so every scan sat for ~9 seconds before
 * anything appeared, and the stats poll regularly ate 9-14s of its own 15s
 * interval.
 *
 * Nothing was gained for that wait. The races-current-warm loop already
 * refreshes the carry about once a second, and it runs the same merge — first
 * call pinning, desk-clear tombstones and all — so the carry IS the realtime
 * read. Every other staff surface (the panels on this very page, at 1s) has
 * been reading it that way all along; the two halves of one box were being fed
 * from two different views of the world, which is its own bug.
 *
 *   "stats"  → the carry or nothing (races-current's own `cacheOnly=1` rule). A
 *              board's count must never be the thing that queues behind a sick
 *              upstream.
 *   "scan"   → the carry, falling through to one live read only when the carry
 *              holds nothing at all (its `prefer=cache` rule). The green/yellow
 *              decision keeps its live backstop for the cold-start case; it
 *              just stops paying ~9s for it on every badge.
 */
async function fetchCurrentRaces(mode: "stats" | "scan" = "scan"): Promise<CurrentRaces> {
  try {
    // READ THE CARRY IN-PROCESS. This used to fetch our OWN route over HTTP —
    // `${origin}/api/pandora/races-current` — which cost a whole extra lambda
    // hop to reach three Redis GETs we can do right here.
    //
    // It was also silently broken anywhere the deployment is protected: a
    // lambda calling its own public URL carries no session cookie, so Vercel's
    // SSO wall answered 302, `res.ok` was false, and this returned `{}` — no
    // called sessions, so the board's count box vanished entirely. Every
    // preview deployment has been showing a check-in board with no counts on
    // it for exactly this reason, which is precisely the surface you would
    // want to test a check-in change on before it reaches the desk.
    //
    // The route's own logic is two exported functions; call them.
    const fromCarry = await loadAllFromRedis();
    if (mode === "stats") return fromCarry;

    // "scan" keeps prefer=cache's shape: the carry, and a live read ONLY when
    // the carry holds nothing at all (a cold Redis, a first boot of the day).
    // The green/yellow gate keeps its backstop; it just stops paying ~9s for it
    // on every badge when the carry already has the answer.
    if (fromCarry.blue || fromCarry.red || fromCarry.mega) return fromCarry;
    return await refreshRacesCurrent(9_000);
  } catch {
    return {};
  }
}

function findSessionInCurrent(
  current: CurrentRaces,
  sessionId: string,
): {
  track: string;
  raceType: string;
  heatNumber: number;
  scheduledStart: string;
  checkingIn: true;
} | null {
  for (const [track, data] of Object.entries(current)) {
    if (!data) continue;
    if (String(data.sessionId ?? "") === sessionId) {
      return {
        track,
        raceType: data.raceType ?? "",
        heatNumber: data.heatNumber ?? 0,
        scheduledStart: data.scheduledStart ?? "",
        checkingIn: true,
      };
    }
  }
  return null;
}

export function findHeadsockCredit(
  deposits: DepositOverviewRow[],
): { depositKindId: string; balance: number } | null {
  if (!HEADSOCK_DEPOSIT_KIND_ID) return null;
  const row = deposits.find((d) => String(d.OUT_DPK_ID) === HEADSOCK_DEPOSIT_KIND_ID);
  if (!row || row.OUT_DPS_AMOUNT <= 0) return null;
  return { depositKindId: String(row.OUT_DPK_ID), balance: row.OUT_DPS_AMOUNT };
}

interface CheckInResult {
  success: boolean;
  error?: string;
  guest?: {
    firstName: string;
    lastName: string;
    pic: string | null;
  };
}

async function checkInViaPandora(
  personId: string,
  sessionId: string,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<CheckInResult> {
  try {
    const body = JSON.stringify({
      locationID: locationId,
      personID: personId,
      sessionID: Number(sessionId),
      checkedIn: true,
    });
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/checkin`, {
      method: "POST",
      headers: pandoraHeaders(),
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Pandora ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json();
    const guest = json?.data ?? json;
    return {
      success: true,
      guest: {
        firstName: guest?.firstName ?? "",
        lastName: guest?.lastName ?? "",
        pic: guest?.pic ? `data:image/jpeg;base64,${guest.pic}` : null,
      },
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * HP Arena scan path — HP-prefixed QRs carry an explicit locationId
 * (arena tickets; HP FM today, Naples-ready). The green/yellow gate is
 * the LIVE called signal from Pandora's sessions/current, IDENTICAL to
 * racing's races-current gate: check in ONLY when the scanned session
 * is the one currently being called (entry appears at
 * SessionAboutToStart, drops ~20 min later). A scheduled-time-window
 * fallback was tried and removed 2026-06-11 — it green-lit a guest
 * from session 50 while session 48 was being called (any session
 * within the window passed). No headsock (racing-only). Not-called
 * scans look up the guest's NEXT arena session (Pandora sessions/next)
 * so staff can say "come back at X" instead of a blank yellow.
 */

/** Live called arena sessions at this location — sessionIds whose
 *  SessionAboutToStart fired in the last ~20 min. Empty set on any
 *  failure (scan degrades to the yellow card, same as racing when
 *  races-current is down). */
async function fetchCalledArenaSessionIds(locationId: string): Promise<Set<string>> {
  try {
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/sessions/current/${locationId}`, {
      headers: pandoraHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return new Set();
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    return new Set(list.map((s: { sessionId?: string | number }) => String(s.sessionId ?? "")));
  } catch {
    return new Set();
  }
}

/** Guest's next unstarted arena session via Pandora sessions/next.
 *  Mirrors fetchNextRace's tri-state so transient Pandora failures
 *  never read as "no session booked". */
async function fetchNextArenaSession(
  locationId: string,
  idType: "person" | "participant",
  id: string,
): Promise<NextRaceResult> {
  try {
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/sessions/next/${locationId}/${idType}/${id}`, {
      headers: pandoraHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { status: "none" };
    if (!res.ok) return { status: "unknown" };
    const json = await res.json();
    const data = json?.data;
    if (!data) return { status: "unknown" };
    const activity = classifyArenaSession(data.type || data.name || "");
    return {
      status: "found",
      race: {
        track: activity ? activityDisplay(activity) : (data.type ?? "HP Arena"),
        raceType: "",
        heatNumber: data.heatNumber ?? null,
        scheduledStart: data.scheduledStart ?? null,
      },
    };
  } catch {
    return { status: "unknown" };
  }
}

async function findArenaSession(
  req: NextRequest,
  locationId: string,
  sessionId: string,
): Promise<{ name: string; scheduledStart: string; heatNumber: number | null } | null> {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    for (const resourceName of ARENA_RESOURCES) {
      const qs = new URLSearchParams({
        locationId,
        resourceName,
        startDate: `${ymd}T00:00:00`,
        endDate: `${ymd}T23:59:59`,
        // Cache-first (cron-warmed), falls through to live on miss —
        // the desk can't wait for a cold Pandora fetch but also can't
        // dead-end on a cache gap.
        prefer: "cache",
      }).toString();
      const res = await fetch(`${req.nextUrl.origin}/api/pandora/sessions?${qs}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const sessions = Array.isArray(json?.data) ? json.data : [];
      const match = sessions.find(
        (s: { sessionId?: string | number }) => String(s.sessionId ?? "") === sessionId,
      );
      if (match) {
        return {
          name: match.name ?? "",
          scheduledStart: match.scheduledStart ?? "",
          heatNumber: match.heatNumber ?? null,
        };
      }
    }
  } catch {
    /* fall through to null — caller degrades to a yellow card */
  }
  return null;
}

async function handleArenaScan(
  req: NextRequest,
  locationId: string,
  personId: string,
  sessionId: string,
  participantId: string | null,
  /** See `dryRun` in POST — resolve and report, write nothing. */
  dryRun = false,
): Promise<NextResponse> {
  const noHeadsock = { detected: false, deducted: false, balance: 0 };
  const [session, guestLookup, calledIds] = await Promise.all([
    findArenaSession(req, locationId, sessionId),
    lookupGuest(sessionId, personId, locationId),
    fetchCalledArenaSessionIds(locationId),
  ]);
  const guest = guestLookup.participant;

  const activity = session ? classifyArenaSession(session.name) : null;
  const trackLabel = activity ? activityDisplay(activity) : "HP Arena";

  const sessionInfo = {
    track: trackLabel,
    raceType: "",
    heatNumber: session?.heatNumber ?? null,
    scheduledStart: session?.scheduledStart ?? null,
  };

  // Green gate: ONLY when THIS session is the one currently being
  // called — identical to racing's races-current gate. No time-window
  // fallback (see the incident note in the block comment above).
  const calledNow = calledIds.has(sessionId);

  if (!calledNow) {
    // Yellow card — this session isn't being called right now. Look up
    // the guest's NEXT arena session so staff can say "come back at X"
    // (mirrors the racing scanner's race/next path). Prefer the stable
    // participantId off a 5-part QR; fall back to a person-wide scan.
    const next = participantId
      ? await fetchNextArenaSession(locationId, "participant", participantId)
      : await fetchNextArenaSession(locationId, "person", personId);
    return NextResponse.json({
      success: true,
      guest: guest
        ? { firstName: guest.firstName, lastName: guest.lastName, pictureUrl: null }
        : null,
      session: sessionInfo,
      currentlyCheckingIn: false,
      headsock: noHeadsock,
      arena: true,
      ...(next.status === "found" ? { nextRace: next.race, nextRaceStatus: "found" } : {}),
      ...(next.status === "none" ? { nextRace: null, nextRaceStatus: "none" } : {}),
      ...(session ? {} : { detail: "Arena session not found in today's schedule" }),
    });
  }

  // ONE SCAN PER GUEST PER SESSION — same rule as racing. No headsock here, so
  // nothing is spent twice, but a re-scan should still tell the desk they are
  // already in rather than silently writing again.
  const firstScan = dryRun
    ? !(await isLocallyCheckedIn(locationId, sessionId, personId))
    : await claimLocalCheckIn(locationId, sessionId, personId);

  if (!firstScan) {
    return NextResponse.json({
      success: true,
      alreadyCheckedIn: true,
      guest: {
        firstName: guest?.firstName || "",
        lastName: guest?.lastName || "",
        pictureUrl: null,
      },
      session: sessionInfo,
      currentlyCheckingIn: true,
      headsock: noHeadsock,
      arena: true,
      detail: "Already checked in for this session",
    });
  }

  const checkinResult = dryRun
    ? ({ success: true } as CheckInResult)
    : await checkInViaPandora(personId, sessionId, locationId);
  // The claim above is the ledger write — so the very next board poll counts
  // this guest whether or not Pandora has caught up. A FAILED write hands the
  // claim back, or the desk could never retry.
  if (!checkinResult.success && !dryRun) {
    await releaseLocalCheckIn(locationId, sessionId, personId);
  }
  return NextResponse.json({
    success: checkinResult.success,
    guest: {
      firstName: checkinResult.guest?.firstName || guest?.firstName || "",
      lastName: checkinResult.guest?.lastName || guest?.lastName || "",
      pictureUrl: checkinResult.guest?.pic ?? null,
    },
    session: sessionInfo,
    currentlyCheckingIn: true,
    headsock: noHeadsock,
    arena: true,
    ...(checkinResult.success ? {} : { detail: checkinResult.error }),
  });
}

/**
 * Licence/member-QR → CALLED arena session. A licence identifies a person,
 * never a venue, so once the racing feed misses we ask each candidate
 * center "is one of this person's sessions being called right now?" —
 * the same green gate an HP QR scan uses. Roster reads come from the
 * cron-warmed participants cache (a CALLED session was re-read by the
 * arena alert cron within the last minute), so a miss degrades to the
 * not-checking-in fallback rather than a cold Pandora fetch.
 *
 * CALLERS PICK THE CENTERS BY NAMESPACE: FM-server licences may match
 * HP FM (shared BMI server with FastTrax); Naples-issued QRs may match
 * ONLY Naples — numeric personIds collide across the two BMI servers.
 */
async function resolveCalledArenaSessionByPerson(
  centers: ArenaCenter[],
  personIds: string[],
): Promise<{
  locationId: string;
  personId: string;
  sessionId: string;
  participantId: string | null;
} | null> {
  for (const center of centers) {
    const calledIds = await fetchCalledArenaSessionIds(center.locationId);
    for (const sessionId of calledIds) {
      if (!sessionId) continue;
      for (const personId of personIds) {
        const match = await lookupGuest(sessionId, personId, center.locationId);
        if (match.participant) {
          const pid = match.participant.participantId;
          return {
            locationId: center.locationId,
            personId,
            sessionId,
            participantId: pid != null && String(pid).trim() ? String(pid) : null,
          };
        }
      }
    }
  }
  return null;
}

interface NextRace {
  track: string | null;
  raceType: string | null;
  heatNumber: number | null;
  scheduledStart: string | null;
}

type NextRaceResult =
  | { status: "found"; race: NextRace }
  | { status: "none" }
  | { status: "unknown" };

/**
 * Look up a racer's next upcoming race via Pandora.
 *   GET /v2/bmi/race/next/{locationID}/{person|participant}/{id}
 * 404 = no race scheduled for that racer. Any transient failure returns
 * "unknown" so callers never assert "no race" when Pandora was just slow/down.
 *
 * NOTE: `id` goes straight into the URL path as a string — never Number()/
 * JSON.stringify a person/participant ID (BMI ID precision rule).
 */
async function fetchNextRace(
  idType: "person" | "participant",
  id: string,
): Promise<NextRaceResult> {
  try {
    const res = await fetch(
      `${PANDORA_BASE}/v2/bmi/race/next/${FASTTRAX_LOCATION_ID}/${idType}/${id}`,
      { headers: pandoraHeaders(), cache: "no-store", signal: AbortSignal.timeout(3000) },
    );
    if (res.status === 404) return { status: "none" };
    if (!res.ok) return { status: "unknown" };
    const json = await res.json();
    const data = json?.data;
    if (!data) return { status: "unknown" };
    // Read each field with the documented races/current name plus the obvious
    // shorter alias, so the track / type / race number all survive regardless of
    // which naming the race/next payload uses.
    return {
      status: "found",
      race: {
        track: (data.trackName ?? data.track)?.toLowerCase() ?? null,
        raceType: data.raceType ?? data.type ?? null,
        heatNumber: data.heatNumber ?? data.raceNumber ?? null,
        scheduledStart: data.scheduledStart ?? null,
      },
    };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Resolve a racer's CURRENT active session from a stable participantId by
 * scanning the currently-checking-in sessions (races-current). Returns the
 * matched session id + the personId from that LIVE roster row, or null when
 * the participant isn't on any active session.
 *
 * Only accepts a match whose personId is a non-empty digit string — skips the
 * placeholder/blank-personId roster rows Pandora occasionally returns, so we
 * never promote a garbage personId (which the headsock deduction keys on).
 *
 * This is what makes a participantId-carrying e-ticket QR move-resilient: the
 * baked sessionId may be stale (racer moved heats), but the participantId
 * still points at wherever the racer actually is right now. Reused by both the
 * 4-part e-ticket QR move-correction and the bare paper-QR path.
 */
/**
 * Same idea as `resolveActiveSessionByParticipant`, keyed on personId — the
 * only identity a WALLET RACING LICENCE carries.
 *
 * A licence says who the racer is, never which heat, so this scans the
 * currently-checking-in sessions (races-current: blue/red/mega, ≤3 cached
 * roster reads) and returns the one they are actually on. That is exactly the
 * right semantic for a check-in desk: if their heat is not open yet there is
 * nothing to check into, and because the answer is always a
 * currently-checking-in session the headsock deduction below is reached under
 * precisely the same condition as an e-ticket scan — no new exposure.
 */
async function resolveActiveSessionByPerson(
  current: CurrentRaces,
  personId: string,
): Promise<{ sessionId: string } | null> {
  for (const [, data] of Object.entries(current)) {
    if (!data) continue;
    const sid = data.sessionId == null ? "" : String(data.sessionId);
    if (!sid) continue;
    const match = await lookupGuest(sid, personId);
    if (match.participant) return { sessionId: sid };
  }
  return null;
}

async function resolveActiveSessionByParticipant(
  current: CurrentRaces,
  participantId: string,
): Promise<{ sessionId: string; personId: string } | null> {
  for (const [, data] of Object.entries(current)) {
    if (!data) continue;
    const sid = data.sessionId == null ? "" : String(data.sessionId);
    if (!sid) continue;
    const match = await lookupByParticipantId(sid, participantId);
    const pid = match?.personId == null ? "" : String(match.personId);
    if (match && /^\d+$/.test(pid)) {
      return { sessionId: sid, personId: pid };
    }
  }
  return null;
}

// --------------- POST: Check in a guest ---------------

/**
 * What was physically presented at the desk, from the payload alone. Mirrors
 * the branching `runCheckinScan` does below rather than guessing — the licence
 * shapes are smstim.in URLs, everything else is `FT:`/`HP:`-prefixed or bare
 * digits, and a 4-part FT QR is the move-resilient one.
 */
function classifyScanKind(raw: string): ScanKind {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "unparsed";
  if (parseMemberQr(trimmed) || parseMemberCode(trimmed)) return "licence";
  const parsed = parseCheckinQr(trimmed);
  if (parsed) {
    if (parsed.locationId) return "arena";
    return parsed.participantId ? "eticket-move" : "eticket";
  }
  if (/^\d+$/.test(trimmed)) return "paper";
  return "unparsed";
}

/** The desk's reading of what just happened, from the response we already built. */
function classifyScanOutcome(payload: {
  success?: boolean;
  alreadyCheckedIn?: boolean;
  currentlyCheckingIn?: boolean;
  guest?: unknown;
}): ScanOutcome {
  if (payload.alreadyCheckedIn) return "already-in";
  if (payload.currentlyCheckingIn) return payload.success ? "checked-in" : "failed";
  if (!payload.guest) return "not-found";
  return "not-checking-in";
}

/**
 * THE SCAN, PLUS ITS OWN RECORD OF ITSELF.
 *
 * The history write lives out here rather than at the thirteen return points
 * inside `runCheckinScan`, so every path — racing, arena, licence, paper, and
 * anything added later — is recorded without anyone having to remember to do
 * it. The outcome is read back off the response that was already built, which
 * means the log and the desk can never disagree about what happened.
 *
 * AWAITED, NOT FIRE-AND-FORGET. A serverless handler is frozen the moment it
 * responds, so a dangling `void` here would be killed mid-write and the history
 * would be silently empty (the same defect that stopped the wallet pushes from
 * ever running, 2026-08-05). It costs a few Redis commands on a path that
 * already spends hundreds of milliseconds upstream.
 */
export async function POST(req: NextRequest) {
  const startedAtMs = Date.now();

  // Cloned so `runCheckinScan` still gets an unread body.
  let raw = "";
  let dryRun = false;
  try {
    const parsed = JSON.parse(await req.clone().text()) as { raw?: string; dryRun?: boolean };
    raw = parsed.raw ?? "";
    dryRun = parsed.dryRun === true;
  } catch {
    /* malformed body — the inner handler will reject it */
  }

  const res = await runCheckinScan(req);

  /**
   * EVERY ATTEMPT, NOT JUST THE ONES THAT WORKED.
   *
   * A 401 is skipped — that is a caller without the token, not a badge at the
   * desk. Everything else is recorded, INCLUDING the 400s, because "could not
   * parse barcode data" is exactly the failure a desk reports as "scanning is
   * broken" and the first draft of this logged nothing at all for it. A history
   * that only holds successes cannot answer the question it exists for.
   */
  if (res.status !== 401) {
    try {
      const payload = (await res.clone().json()) as {
        success?: boolean;
        alreadyCheckedIn?: boolean;
        currentlyCheckingIn?: boolean;
        guest?: { firstName?: string } | null;
        session?: { track?: string | null; heatNumber?: number | null };
        headsock?: { detected?: boolean };
        diag?: { ms?: Record<string, number> };
        checkinError?: string | null;
        detail?: string;
        error?: string;
      };

      const ok = res.status === 200;
      const outcome: ScanOutcome = ok ? classifyScanOutcome(payload) : "unreadable";

      // The upstream's own words, in preference order, truncated. A failed
      // check-in whose reason is missing is barely more useful than no row.
      const why =
        payload.checkinError ||
        payload.detail ||
        payload.error ||
        (outcome === "failed" ? "check-in refused, no reason given" : null);

      await recordScan({
        atMs: startedAtMs,
        kind: classifyScanKind(raw),
        outcome,
        totalMs: Date.now() - startedAtMs,
        ms: payload.diag?.ms,
        track: payload.session?.track ?? null,
        heatNumber: payload.session?.heatNumber ?? null,
        firstName: payload.guest?.firstName ?? null,
        headsock: payload.headsock?.detected === true,
        dryRun,
        detail:
          outcome === "checked-in" || outcome === "already-in"
            ? null
            : why
              ? String(why).slice(0, 200)
              : null,
        ...(ok ? {} : { status: res.status }),
      });
    } catch {
      /* never let the diagnostic affect the scan it is describing */
    }
  }

  return res;
}

async function runCheckinScan(req: NextRequest): Promise<NextResponse> {
  if (!(await auth(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { personId?: string; sessionId?: string; raw?: string; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  /**
   * DRY RUN — resolve and report, write NOTHING.
   *
   * Suppresses exactly the four things a scan changes in the world: the Pandora
   * check-in, our own local check-in credit, the headsock deduction, and the
   * lobby-TV events. Everything else runs untouched, so what comes back is what
   * a real scan WOULD have said.
   *
   * Reads are deliberately still live, including the deposit read — the point is
   * to report that a headsock is due, and knowing that requires asking. Only the
   * WRITE is withheld.
   *
   * A physical scan can never set this: the scanner posts `{ raw }` and nothing
   * else. It exists for the gear's "Look up" button, which is why it is safe to
   * hand to a desk in the middle of a race night.
   */
  const dryRun = body.dryRun === true;

  /** Where the time went. Attached to every response; only the gear shows it. */
  const startedAtMs = Date.now();
  const ms: Record<string, number> = {};
  async function timed<T>(label: string, work: Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await work;
    } finally {
      ms[label] = Date.now() - t0;
    }
  }
  const diag = () => ({ dryRun, ms: { ...ms, total: Date.now() - startedAtMs } });

  let personId = body.personId;
  let sessionId = body.sessionId;
  // Stable participantId off a 4-part e-ticket QR (FT:pid:sid:participantId).
  // Drives move-resilient live-session resolution below; null for 3-part QRs
  // and bare paper QRs, which keep their existing behavior.
  let qrParticipantId: string | null = null;
  // Explicit locationId off an HP-prefixed (arena) QR. Null for all FT
  // QRs and paper QRs — those stay on the racing path below.
  let qrLocationId: string | null = null;

  // A WALLET RACING LICENCE. Checked FIRST, and it cannot collide with
  // anything below: both licence shapes are smstim.in URLs, while every
  // existing payload here is `FT:`/`HP:`-prefixed or bare digits.
  //
  // A licence identifies a PERSON, not a heat, so it cannot go through
  // parseCheckinQr (which needs a sessionId baked in). It resolves to the heat
  // the racer is checking into RIGHT NOW, then joins the standard path below
  // completely unchanged — same BMI check-in write, same headsock rules.
  let licenceCode: string | null = null;
  if (body.raw) {
    // A typed bare code counts too — staff read it off the pass when a
    // licence will not scan. Wrapped forms first; the bare form can never
    // collide with them (it has no scheme, host or colon).
    const trimmedRaw = body.raw.trim();
    const qr = parseMemberQr(trimmedRaw) ?? parseMemberCode(trimmedRaw);
    if (qr) {
      licenceCode = qr.code;
      // NAMESPACE ROUTING. A Naples-issued app QR (clientKey
      // "headpinznaples") resolves against the Naples Office DB and may
      // ONLY match Naples sessions — Naples runs its own BMI server, so
      // its numeric personIds collide with FM's. Everything else (wallet
      // licences carry no clientKey; FM app QRs carry headpinzftmyers)
      // resolves against the FM Office as always and may match FT racing
      // + HP FM arena, which share one BMI server.
      const isNaplesQr = (qr.clientKey || "") === NAPLES_CLIENT_KEY;
      const people = isNaplesQr
        ? await lookupMemberMatchesAt(NAPLES_CLIENT_KEY, qr.code).catch(() => null)
        : await lookupMemberMatches(qr.code, qr.clientKey || undefined).catch(() => null);
      if (people === null || people.length === 0) {
        // `[]` is also what a degraded Office person subsystem returns — it
        // answers empty rather than erroring (four hours of that on
        // 2026-08-03), so this is logged rather than silently read as "no such
        // racer". No PII in the log line.
        console.warn(
          `[admin-checkin] licence resolved ${people === null ? "ERROR" : "nobody"} — Office search may be degraded`,
        );
        return NextResponse.json({
          success: false,
          guest: null,
          session: { track: null, raceType: null, heatNumber: null, scheduledStart: null },
          currentlyCheckingIn: false,
          headsock: { detected: false, deducted: false, balance: 0 },
          nextRaceStatus: "unknown",
          detail: "Licence not recognised",
        });
      }
      const personIds = people.map((p) => String(p.personId));

      // Naples namespace: arena is the only surface, and the only venue
      // these personIds are valid against.
      if (isNaplesQr) {
        const arena = await resolveCalledArenaSessionByPerson(
          activeArenaCenters().filter((c) => c.locationId === HP_NAPLES_LOCATION_ID),
          personIds,
        );
        if (arena) {
          return handleArenaScan(
            req,
            arena.locationId,
            arena.personId,
            arena.sessionId,
            arena.participantId,
            dryRun,
          );
        }
        // Known Naples guest, nothing called right now — say when their
        // next session is (mirrors the racing fallback below; the FM racer
        // pass has nothing for a Naples-namespace personId).
        const m = people[0];
        const next = await fetchNextArenaSession(HP_NAPLES_LOCATION_ID, "person", personIds[0]);
        const nextRaceText =
          next.status === "found" && next.race.scheduledStart
            ? `${new Date(next.race.scheduledStart).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/New_York",
              })}${next.race.track ? ` · ${next.race.track}` : ""}`
            : null;
        return NextResponse.json({
          success: false,
          guest: {
            firstName: m.fullName.split(/\s+/)[0] ?? "",
            lastName: m.fullName.split(/\s+/).slice(1).join(" "),
          },
          session: { track: null, raceType: null, heatNumber: null, scheduledStart: null },
          currentlyCheckingIn: false,
          headsock: { detected: false, deducted: false, balance: 0 },
          nextRaceStatus: "none",
          nextRaceText,
          detail: nextRaceText
            ? "Not checking in yet — next session shown"
            : "No session checking in right now",
        });
      }

      // One human can hold several Office records; the live roster is the
      // tie-breaker, which beats guessing by recency.
      const current0 = await fetchCurrentRaces();
      let picked: { personId: string; sessionId: string } | null = null;
      for (const p of people) {
        const live = await resolveActiveSessionByPerson(current0, String(p.personId));
        if (live) {
          picked = { personId: String(p.personId), sessionId: live.sessionId };
          break;
        }
      }
      if (!picked) {
        // No FT racing heat open — the same person may be checking into an
        // HP FM ARENA session (same BMI server, same personId namespace),
        // so ask the arena's called feed before concluding "nothing".
        // Licences were FT-only until 2026-08-16; this is what makes them
        // work at every desk on this server.
        const arena = await resolveCalledArenaSessionByPerson(
          activeArenaCenters().filter((c) => c.locationId !== HP_NAPLES_LOCATION_ID),
          personIds,
        );
        if (arena) {
          return handleArenaScan(
            req,
            arena.locationId,
            arena.personId,
            arena.sessionId,
            arena.participantId,
            dryRun,
          );
        }
        // Known racer, no heat OPEN yet. Not an error — but "No upcoming race
        // found" is the wrong thing to tell a desk attendant about a racer who
        // is on tonight's grid, so say WHEN they race.
        //
        // Not from race/next/{loc}/person/{id}: that endpoint answers the next
        // unstarted session EVER, which for real records is a stale 2023 Axe
        // Lane booking or a 2025 arena match (both re-measured 2026-08-05).
        //
        // The racer's own licence row instead. It is only reachable here
        // because they just scanned a licence, the pre-race cron rewrites it
        // every 2 minutes, and it is already timezone-correct — so the desk and
        // the pass in their hand cannot disagree.
        const m = people[0];
        let nextRaceText: string | null = null;
        for (const p of people) {
          const row = await getRacerPass(String(p.personId)).catch(() => null);
          const text = row?.nextRace?.trim();
          // NO_NEXT_RACE ("None in next 2 hrs") is a real answer, not a race.
          if (text && !/^none\b/i.test(text)) {
            const label = row?.meta?.raceLabel;
            nextRaceText = label && !text.includes(label) ? `${text} · ${label}` : text;
            break;
          }
        }
        return NextResponse.json({
          success: false,
          guest: {
            firstName: m.fullName.split(/\s+/)[0] ?? "",
            lastName: m.fullName.split(/\s+/).slice(1).join(" "),
          },
          session: { track: null, raceType: null, heatNumber: null, scheduledStart: null },
          currentlyCheckingIn: false,
          headsock: { detected: false, deducted: false, balance: 0 },
          nextRaceStatus: "none",
          nextRaceText,
          detail: nextRaceText
            ? "Not checking in yet — next race shown"
            : "No race checking in right now",
        });
      }
      personId = picked.personId;
      sessionId = picked.sessionId;
    }
  }

  if (body.raw && !licenceCode) {
    const raw = body.raw.trim();
    const parsed = parseCheckinQr(raw);
    if (parsed) {
      personId = parsed.personId;
      sessionId = parsed.sessionId;
      qrParticipantId = parsed.participantId ?? null;
      qrLocationId = parsed.locationId ?? null;
    } else if (/^\d+$/.test(raw)) {
      // Bare number — paper QR with just the participant ID.
      // Search active sessions to find which one they're on.
      personId = raw;
      sessionId = undefined;
    } else {
      return NextResponse.json(
        { error: "invalid QR", detail: "Could not parse barcode data" },
        { status: 400 },
      );
    }
  }

  // For e-ticket QR: validate personId now. For paper QR: personId is
  // undefined at this point (filled after participateId search below).
  if (sessionId && (!personId || !/^\d+$/.test(personId))) {
    return NextResponse.json(
      { error: "invalid input", detail: "personId must be a digit string" },
      { status: 400 },
    );
  }

  // HP Arena QR — diverges entirely from the racing flow (no headsock,
  // called-signal/time-window gate, sessions/next for "come back at X").
  // See handleArenaScan.
  if (qrLocationId && personId && sessionId) {
    return handleArenaScan(req, qrLocationId, personId, sessionId, qrParticipantId, dryRun);
  }

  // Get races-current first (needed for both e-ticket QR and paper QR paths)
  const current = await fetchCurrentRaces();

  // Move-resilient e-ticket QR: a 4-part QR carries a stable participantId.
  // The baked sessionId may be stale (racer moved heats), so resolve the
  // racer's LIVE active session from participantId and override both ids. On
  // no match we leave the baked values untouched → identical to legacy 3-part
  // behavior (and the early-scan branch below handles a moved-early racer).
  if (qrParticipantId && sessionId && personId) {
    const live = await resolveActiveSessionByParticipant(current, qrParticipantId);
    if (live) {
      sessionId = live.sessionId;
      personId = live.personId;
    }
  }

  // Paper QR path: bare participateId — search active sessions by participateId
  // (field added by Pandora; gracefully returns "not found" until it ships)
  let paperQrParticipantId: string | null = null;
  if (!sessionId) {
    paperQrParticipantId = personId ?? "";
    personId = "";

    const live = await resolveActiveSessionByParticipant(current, paperQrParticipantId);
    if (live) {
      sessionId = live.sessionId;
      personId = live.personId;
    }
  }

  // If we still don't have a sessionId or personId (paper QR not found in active
  // sessions), return a yellow warning — we can't check them in without knowing the
  // session. But if this was a bare paper-QR participant ID, look up their next
  // upcoming race so staff can tell them when to come back instead of a dead-end
  // "not found".
  if (!sessionId || !personId || !/^\d+$/.test(sessionId) || !/^\d+$/.test(personId)) {
    const emptySession = { track: null, raceType: null, heatNumber: null, scheduledStart: null };
    const noHeadsock = { detected: false, deducted: false, balance: 0 };

    if (paperQrParticipantId) {
      const next = await fetchNextRace("participant", paperQrParticipantId);
      if (next.status === "found") {
        return NextResponse.json({
          success: false,
          guest: null,
          session: next.race,
          currentlyCheckingIn: false,
          headsock: noHeadsock,
          nextRace: next.race,
          nextRaceStatus: "found",
        });
      }
      if (next.status === "none") {
        return NextResponse.json({
          success: false,
          guest: null,
          session: emptySession,
          currentlyCheckingIn: false,
          headsock: noHeadsock,
          nextRace: null,
          nextRaceStatus: "none",
          detail: "No upcoming race found",
        });
      }
      // "unknown" — Pandora was slow/errored; fall through to the generic
      // not-found response below rather than claiming they have no race.
    }

    return NextResponse.json({
      success: false,
      guest: null,
      session: emptySession,
      currentlyCheckingIn: false,
      headsock: noHeadsock,
      nextRaceStatus: "unknown",
      detail: "Participant not found in any active session",
    });
  }

  // Standard path: we have both personId and sessionId
  const guestResult = await lookupGuest(sessionId, personId);

  const sessionMatch = findSessionInCurrent(current, sessionId);
  const currentlyCheckingIn = !!sessionMatch;

  const guest = guestResult.participant;
  let track = sessionMatch?.track ?? null;
  let raceType = sessionMatch?.raceType ?? null;
  let heatNumber = sessionMatch?.heatNumber ?? null;
  let scheduledStart = sessionMatch?.scheduledStart ?? null;

  // VIP + birthday + back-to-back flags — kicked off NOW so they run in
  // parallel with the headsock/check-in work below and never slow the flash.
  // All fail-open (false/null on any error). VIP and birthday badge the green
  // AND yellow guest cards; back-to-back only applies when actually checking
  // in — its "next 2 heats" anchor is the heat being checked into.
  const todayEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const vipPromise = isVipComboPersonOnDate(personId, todayEt).catch(() => false);
  const birthdayPromise = fetchIsBirthdayToday(personId, todayEt).catch(() => false);
  const backToBackPromise = currentlyCheckingIn
    ? findBackToBackRace(req, {
        sessionId,
        scheduledStart: sessionMatch?.scheduledStart ?? "",
        personId,
        participantId: qrParticipantId,
      }).catch(() => null)
    : Promise.resolve(null);

  // Move-resilient early scan: a 4-part e-ticket QR whose racer is NOT on the
  // baked session's roster means they were moved to a different heat. Their
  // new heat isn't checking in yet (or we'd have corrected sessionId above), so
  // show their CURRENT next race instead of the stale booked one. Non-moved
  // racers (still on the baked roster) fall through to the booked-session
  // display below, so their experience is unchanged.
  if (!currentlyCheckingIn && qrParticipantId) {
    const stillOnBaked = await lookupByParticipantId(sessionId, qrParticipantId);
    if (!stillOnBaked) {
      const next = await fetchNextRace("participant", qrParticipantId);
      if (next.status === "found") {
        return NextResponse.json({
          success: false,
          guest: null,
          session: next.race,
          currentlyCheckingIn: false,
          headsock: { detected: false, deducted: false, balance: 0 },
          nextRace: next.race,
          nextRaceStatus: "found",
        });
      }
      // none/unknown → fall through to the booked-session display below.
    }
  }

  // When session is NOT currently checking in, fetch session metadata
  // from Pandora so we can tell staff what session this guest is booked for
  if (!currentlyCheckingIn) {
    try {
      const sessRes = await fetch(
        `${PANDORA_BASE}/v2/bmi/session/${FASTTRAX_LOCATION_ID}/${sessionId}`,
        { headers: pandoraHeaders(), cache: "no-store", signal: AbortSignal.timeout(3000) },
      );
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        const sess = sessData?.data;
        if (sess) {
          track = sess.trackName?.toLowerCase() ?? track;
          raceType = sess.raceType ?? raceType;
          heatNumber = sess.heatNumber ?? heatNumber;
          scheduledStart = sess.scheduledStart ?? scheduledStart;
        }
      }
    } catch {
      // Pandora session lookup failed — proceed with whatever we have
    }
  }

  // Headsock + Pandora check-in only when session IS currently checking in.
  // Yellow "are you sure?" scans should not deduct headsock or call check-in.
  const headsock: { detected: boolean; deducted: boolean; balance: number } = {
    detected: false,
    deducted: false,
    balance: 0,
  };
  if (currentlyCheckingIn) {
    /**
     * ONE SCAN PER RACER PER HEAT — claimed before a single credit is spent.
     *
     * A dry run must only ASK (`isLocallyCheckedIn`), never claim: consuming
     * the claim here would make the real scan that follows look like the
     * duplicate, which is the exact opposite of what a test should do.
     */
    const firstScan = dryRun
      ? !(await isLocallyCheckedIn(FASTTRAX_LOCATION_ID, sessionId, personId))
      : await claimLocalCheckIn(FASTTRAX_LOCATION_ID, sessionId, personId);

    if (!firstScan) {
      // Already in. No Pandora write, no headsock deduction, no lobby-TV cue —
      // the racer is checked in and has already been handed whatever they were
      // owed. The desk needs to know that and nothing else.
      const [vip, birthday, backToBack] = await timed(
        "flags",
        Promise.all([vipPromise, birthdayPromise, backToBackPromise]),
      );
      return NextResponse.json({
        success: true,
        alreadyCheckedIn: true,
        guest: guest
          ? { firstName: guest.firstName, lastName: guest.lastName, pictureUrl: null }
          : null,
        session: { track, raceType, heatNumber, scheduledStart },
        currentlyCheckingIn,
        headsock,
        vip,
        birthday,
        backToBack,
        detail: "Already checked in for this heat",
        diag: diag(),
      });
    }

    if (HEADSOCK_DEPOSIT_KIND_ID) {
      try {
        const deposits = await timed("deposit", getDepositOverview(personId, FASTTRAX_LOCATION_ID));
        const hs = findHeadsockCredit(deposits);
        if (hs) {
          headsock.detected = true;
          headsock.balance = hs.balance;
          // The READ above still ran — a dry run must be able to report that a
          // headsock is due. Only the deduction is withheld.
          if (!dryRun) {
            addDeposit({
              personId,
              depositKindId: hs.depositKindId,
              amount: -1,
              locationId: FASTTRAX_LOCATION_ID,
            }).catch((e) => {
              enqueueDepositFailure({
                source: "headsock-checkin",
                sourceRef: `${personId}-${sessionId}`,
                locationId: FASTTRAX_LOCATION_ID,
                personId,
                depositKindId: hs.depositKindId,
                amount: -1,
                initialError: e instanceof Error ? e.message : "Unknown",
              }).catch(() => {});
            });
          }
        }
      } catch {
        // Deposit read failed — don't block check-in
      }
    }

    // Await Pandora check-in — returns guest photo as base64.
    // A dry run reports the check-in it WOULD have made and writes nothing; the
    // guest name then comes from the cached roster row below, not from the
    // check-in response.
    const checkinResult = dryRun
      ? ({ success: true } as CheckInResult)
      : await timed("checkin", checkInViaPandora(personId, sessionId));
    /**
     * OUR OWN WRITE, IN OUR OWN LEDGER — already done. The claim above added
     * this racer to the very set `applyLocalFloor` counts, which is what stops
     * the count sliding backwards between polls, so there is nothing to credit
     * here any more.
     *
     * What IS needed is the reverse: a check-in that FAILED must give the claim
     * back. Otherwise the failure looks identical to a success on the next scan
     * and the desk can never retry the racer it just failed to check in.
     */
    if (!checkinResult.success && !dryRun) {
      await releaseLocalCheckIn(FASTTRAX_LOCATION_ID, sessionId, personId);
    }
    const checkinGuest = checkinResult.guest;

    const guestResponse = {
      firstName: checkinGuest?.firstName || guest?.firstName || "",
      lastName: checkinGuest?.lastName || guest?.lastName || "",
      pictureUrl: checkinGuest?.pic ?? null,
    };

    // Timed as one block: these three were started before the deposit read and
    // the write, so this measures what the scan actually WAITED for them — the
    // number that says whether the birthday lookup is still the critical path.
    const [vip, birthday, backToBack] = await timed(
      "flags",
      Promise.all([vipPromise, birthdayPromise, backToBackPromise]),
    );

    // Tell the lobby TVs. Scoped to the resource so a Blue Track scan lights
    // the Blue board only, and carrying the birthday flag that turns both
    // karting boards over.
    //
    // Fire-and-forget, and recordSignageEvent swallows everything it can throw:
    // a display cue must never be able to fail a check-in. Not awaited either —
    // the racer is standing at the desk waiting for this response.
    if (checkinResult.success && !dryRun) {
      const trackKey = trackFromName(track);
      void recordSignageEvent({
        id: `scan-${personId}-${sessionId}-${Date.now()}`,
        // Same person, same heat — the board shows them once however many times
        // they swipe. The id has to stay unique (it keys the flash animation), so
        // the identity travels separately.
        racerKey: `${personId}:${sessionId}`,
        kind: "racer-scanned",
        center: "fort-myers",
        // First name only — it is going on a public wall.
        firstName: guestResponse.firstName || undefined,
        resourceId: trackKey ? TRACK_RESOURCE_IDS[trackKey] : undefined,
        activityKeys: ["racing"],
        birthday: birthday === true,
        headsockDue: headsock.detected === true,
        atMs: Date.now(),
      });
    }

    return NextResponse.json({
      success: checkinResult.success,
      guest: guestResponse,
      session: { track, raceType, heatNumber, scheduledStart },
      currentlyCheckingIn,
      headsock,
      vip,
      birthday,
      backToBack,
      diag: diag(),
    });
  }

  // Session not checking in — no Pandora call, just return guest info from cache
  const guestResponse = guest
    ? {
        firstName: guest.firstName,
        lastName: guest.lastName,
        pictureUrl: null,
      }
    : null;

  // They scanned for a heat that is not the one checking in. Put it on the
  // boards so the racer sees WHY nothing happened and when they should be
  // back — otherwise they walk away thinking they are checked in, and turn up
  // to a heat that has already run.
  //
  // Scoped to the track, unlike a birthday: this concerns one person at one
  // desk, not the building. Fire-and-forget, never throws.
  if (!dryRun) {
    const trackKey = trackFromName(track);
    void recordSignageEvent({
      id: `wrong-${personId ?? "unknown"}-${Date.now()}`,
      kind: "racer-wrong-race",
      center: "fort-myers",
      firstName: guestResponse?.firstName || undefined,
      resourceId: trackKey ? TRACK_RESOURCE_IDS[trackKey] : undefined,
      activityKeys: ["racing"],
      theirRaceLabel: formatHeatLabel(track, raceType, scheduledStart),
      atMs: Date.now(),
    });
  }

  return NextResponse.json({
    success: true,
    guest: guestResponse,
    session: {
      track,
      raceType,
      heatNumber,
      scheduledStart,
    },
    currentlyCheckingIn,
    headsock,
    vip: await vipPromise,
    birthday: await timed("flags", birthdayPromise),
    backToBack: null,
    diag: diag(),
  });
}

// --------------- Session stats (the board's session strip) ---------------

interface SessionStat {
  track: string;
  raceType: string;
  heatNumber: number;
  sessionId: number | string;
  scheduledStart: string;
  /**
   * NULL MEANS WE DO NOT KNOW, and the board prints "—" for it. It does NOT
   * mean nobody is booked; see roster-count.ts for why that distinction cost us
   * a night of a board contradicting itself.
   */
  checkedIn: number | null;
  total: number | null;
  /** The count is the last one we read rather than a fresh one. The board dims
   *  it; nothing else changes. */
  stale: boolean;
  /** Locates the participant fetch — arena rows count at HP FM. */
  locationId: string;
}

/**
 * THE SHARED CACHE LIVES IN REDIS, PER SESSION — not in this module, and not
 * over the whole strip.
 *
 * It used to be one module-level snapshot of the entire strip, held 10s. Two
 * things were wrong with that, and on 2026-08-18 both fired at once:
 *
 *   1. MODULE MEMORY IS PER LAMBDA INSTANCE. Vercel fans concurrent polls
 *      across instances, so each kept its own snapshot. One caught a Pandora
 *      hang and cached "0/0"; another caught a good window and cached "5/5".
 *      The board's 15s poll landed on whichever answered, so it ALTERNATED
 *      rather than converging — the displayed value changed on eight of ten
 *      consecutive polls while the true roster never moved. A shared cache in
 *      Redis cannot disagree with itself.
 *
 *   2. CACHING THE WHOLE STRIP CACHED THE SESSION IDENTITY TOO. When Pandora
 *      rolled from heat 26 to heat 27, a cached snapshot went on naming heat 26
 *      — with heat 26's count — for up to ten seconds, and instances disagreed
 *      about which heat was even being called. Measured that evening: ~26
 *      seconds showing the wrong heat. So the session LIST is no longer cached
 *      here at all. It comes from the races-current carry, which the warm loop
 *      keeps ~1s fresh and costs three Redis GETs; only the expensive part —
 *      one participants read per session — is cached, under the session's own
 *      id, where it cannot outlive the heat it counts.
 *
 * `inFlight` stays, and is now the only per-instance state: it collapses the
 * polls of several tabs on one instance onto a single fan-out. That is pure
 * de-duplication with no staleness of its own, and it matters most exactly when
 * the upstream is slow.
 */
const ROSTER_KEY = (locationId: string, sessionId: string | number) =>
  `checkin:roster:${locationId}:${sessionId}`;
/** Long enough to outlive any called heat, so a failed read always has the
 *  same heat's earlier count to fall back on. Expiry is the backstop; the
 *  freshness rules live in roster-count.ts. */
const ROSTER_KEY_TTL_SEC = 45 * 60;
/**
 * THE PEOPLE THIS DESK HAS SCANNED INTO A SESSION — our own ledger of our own
 * writes, and the floor under whatever Pandora reports (see applyLocalFloor).
 *
 * A SET, not a counter, so a racer who scans twice — or whose badge is read
 * twice by a scanner that fires on both edges — is counted once. `sadd`
 * returning 0 is the duplicate telling us about itself.
 */
const ROSTER_SEEN_KEY = (locationId: string, sessionId: string | number) =>
  `checkin:roster-seen:${locationId}:${sessionId}`;
let sessionStatsInFlight: Promise<SessionStat[]> | null = null;

/**
 * CLAIM A RACER FOR A HEAT, ATOMICALLY, BEFORE ANYTHING IS SPENT.
 *
 * Returns true only for the FIRST scan of this person into this session. The
 * set above already noted that "`sadd` returning 0 is the duplicate telling us
 * about itself"; this is the thing that finally listens to it.
 *
 * WHY IT MATTERS, AND IT IS NOT COSMETIC. A second scan re-read the deposit
 * balance and deducted a SECOND headsock credit — a scanner that fires on both
 * edges of a badge, a racer who swipes again because nobody told them it
 * worked, or two desks scanning the same person at once all spent real credit.
 * `sadd` is atomic, so even the simultaneous case has exactly one winner.
 *
 * FAILS OPEN. If Redis is unreachable this reports "first scan" and the scan
 * proceeds exactly as it did before. A rare double credit is recoverable and
 * refundable; a check-in desk that stops working because a cache is down is
 * not. The asymmetry is the whole decision.
 */
async function claimLocalCheckIn(
  locationId: string,
  sessionId: string | number,
  personId: string,
): Promise<boolean> {
  if (!sessionId || !personId) return true;
  try {
    const key = ROSTER_SEEN_KEY(locationId, sessionId);
    const added = await redis.sadd(key, personId);
    await redis.expire(key, ROSTER_KEY_TTL_SEC);
    return added === 1;
  } catch {
    return true;
  }
}

/** Has this desk already scanned them in? Read-only — used by a dry run, which
 *  must never consume the claim a real scan is about to need. */
async function isLocallyCheckedIn(
  locationId: string,
  sessionId: string | number,
  personId: string,
): Promise<boolean> {
  if (!sessionId || !personId) return false;
  try {
    return (await redis.sismember(ROSTER_SEEN_KEY(locationId, sessionId), personId)) === 1;
  } catch {
    return false;
  }
}

/**
 * GIVE THE CLAIM BACK. Called when the check-in we claimed for then FAILED.
 * Without this a failed write would be indistinguishable from a completed one
 * and the racer could never be re-scanned — the desk would be locked out of
 * fixing it, which is worse than the duplicate we were preventing.
 */
async function releaseLocalCheckIn(
  locationId: string,
  sessionId: string | number,
  personId: string,
): Promise<void> {
  if (!sessionId || !personId) return;
  try {
    await redis.srem(ROSTER_SEEN_KEY(locationId, sessionId), personId);
  } catch {
    /* the racer stays claimed; staff can still use Override */
  }
}

/*
 * `creditLocalCheckIn` used to live here. `claimLocalCheckIn` above does the
 * same write and also reports whether the racer was already in the set, so the
 * unconditional version had no remaining caller.
 */

/** How many people this desk has scanned into this session. */
async function localCheckInCount(locationId: string, sessionId: string | number): Promise<number> {
  try {
    return (await redis.scard(ROSTER_SEEN_KEY(locationId, sessionId))) ?? 0;
  } catch {
    return 0;
  }
}

/** The last count we stored for this exact session, or null. */
async function loadRosterCount(
  locationId: string,
  sessionId: string | number,
): Promise<RosterCount | null> {
  try {
    return parseStoredRoster(await redis.get(ROSTER_KEY(locationId, sessionId)));
  } catch {
    return null;
  }
}

/** Remember a counted roster against its own session id. Never called with an
 *  unknown count — we store what we counted, never what we guessed. */
async function saveRosterCount(
  locationId: string,
  sessionId: string | number,
  count: RosterCount,
): Promise<void> {
  if (count.total === null || count.atMs === null) return;
  try {
    await redis.set(
      ROSTER_KEY(locationId, sessionId),
      JSON.stringify({ checkedIn: count.checkedIn, total: count.total, atMs: count.atMs }),
      "EX",
      ROSTER_KEY_TTL_SEC,
    );
  } catch {
    /* a count we failed to remember is not a count we may not serve */
  }
}

/**
 * One session's roster: the shared fresh copy, else a live read, else the last
 * number we counted for THIS session, else honestly unknown.
 */
/** The roster the scan lookup reads, if Redis already holds it. Instant. */
async function loadSharedRoster(
  locationId: string,
  sessionId: string | number,
): Promise<RosterParticipant[] | null> {
  try {
    const raw = await redis.get(participantsCacheKey(locationId, sessionId, true));
    if (!raw) return null;
    const list = JSON.parse(raw) as RosterParticipant[];
    if (!Array.isArray(list) || list.length === 0) return null;
    return dropNullParticipants(list);
  } catch {
    return null;
  }
}

/**
 * One live roster read: the count it produces, and the roster it shares.
 *
 * Extracted so it can be AWAITED when we have nothing else to show, and fired
 * and forgotten when we have already answered from the shared cache. Returns
 * null on any failure — the caller decides what may be claimed.
 */
async function refreshRosterFromPandora(
  s: SessionStat,
): Promise<{ checkedIn: number; total: number } | null> {
  try {
    // THE SAME QUERY THE PROXY USES, because we write into the same cache below.
    // `excludeUnpaid` is pinned false: the shared key holds the unpaid SUPERSET,
    // and storing a paid-only slice would delete unpaid racers from every reader
    // of it — including the scan lookup, which would then tell a racer standing
    // at the desk that they are not in any active session. See
    // ~/features/racing/session-roster.server.
    const pRes = await fetch(
      `${PANDORA_BASE}/v2/bmi/session/${s.locationId}/${s.sessionId}/participants?${rosterUpstreamQuery(true)}`,
      {
        headers: pandoraHeaders(),
        cache: "no-store",
        // 9s, not the old 5s. This runs in iad1, where this repo has measured
        // Pandora at 5-10s (2026-08-13) — the old cap was being blown by a
        // HEALTHY upstream, and every blown cap printed a "0/0" over a full
        // heat. The board polls at 15s, so 9s still lands inside its interval,
        // and a read that misses now costs a dimmed count rather than a lie.
        signal: AbortSignal.timeout(9_000),
      },
    );
    if (!pRes.ok) return null;
    const pData = await pRes.json();
    const raw = Array.isArray(pData?.data) ? (pData.data as RosterParticipant[]) : [];
    const list = dropNullParticipants(raw);

    // WRITE THE ROSTER THE SCAN LOOKUP READS.
    //
    // lookupGuest / lookupByParticipantId resolve a badge against this key and
    // return "not found in any active session" on a miss. Its only writer was
    // the check-in-alerts cron, once a minute — which on a bad Pandora night
    // fails a large share of its ticks, and if none succeeds inside the 10
    // minute TTL the key EXPIRES and every badge for that heat scans as unknown.
    //
    // We are already holding a live, clean roster for a called session, pulled
    // with the proxy's own query. Storing it means the lookup is refreshed by
    // whatever the board is doing anyway — and a racer moved into this heat is
    // findable within a poll rather than within a cron tick.
    if (rosterIsWorthCaching(list)) {
      void redis
        .set(
          participantsCacheKey(s.locationId, s.sessionId, true),
          JSON.stringify(list),
          "EX",
          PARTICIPANTS_CACHE_TTL_SEC,
        )
        .catch(() => {
          /* a roster we failed to share is still a roster we can count */
        });
    }

    return {
      total: list.length,
      checkedIn: list.filter((p) => !!(p as { checkedIn?: string | null }).checkedIn).length,
    };
  } catch {
    return null;
  }
}

async function rosterFor(s: SessionStat): Promise<RosterCount> {
  const now = Date.now();
  const sid = String(s.sessionId);
  const [lastKnown, credited, marks, bridgeStamp] = await Promise.all([
    loadRosterCount(s.locationId, s.sessionId),
    localCheckInCount(s.locationId, s.sessionId),
    readRosterMarks("checkin", [sid]),
    redis.get("kart:bridge:last-event").catch(() => null),
  ]);

  /**
   * ASK THE WIRE BEFORE ASKING PANDORA.
   *
   * The ten-second window below is a guess about how long we are willing to be
   * wrong for, and every tick past it buys a Pandora read whether or not
   * anything moved. The venue's broadcast already knows, and mostly the answer
   * is "nothing" — so while it is alive and silent about this heat, the stored
   * count is not stale, it is current.
   *
   * Falls back to the plain ten seconds whenever the marks cannot decide (no
   * heartbeat, no mark, Redis unreachable), so this is safe before anything
   * starts writing them. See rosterIsFreshForWire.
   */
  const beat = bridgeStamp ? Date.parse(bridgeStamp) : NaN;
  const bridgeAlive = Number.isFinite(beat) && now - beat <= BRIDGE_STALE_MS;
  const mark = marks.get(sid) ?? { dirtyCounter: null, readCounter: null, lastReadMs: null };
  if (
    rosterIsFreshForWire({
      entry: lastKnown,
      nowMs: now,
      dirtyCounter: mark.dirtyCounter,
      readCounter: mark.readCounter,
      bridgeAlive,
    })
  ) {
    return applyLocalFloor({ ...lastKnown!, stale: false }, credited);
  }
  // Bank BEFORE the read, so a racer added while it is in flight is not
  // swallowed — see bankRosterRead.
  void bankRosterRead("checkin", sid, mark.dirtyCounter, now);

  // THE MOMENT A HEAT IS CALLED, THE COUNT HAS TO BE THERE (owner 2026-08-18:
  // "we need that data soon as we call").
  //
  // A heat called seconds ago has no `checkin:roster` entry yet, so the only
  // way to a number used to be a live Pandora read — and on a night when that
  // takes 9s, or times out, the desk got a called heat with no count beside it
  // at exactly the moment staff start scanning it.
  //
  // But the roster is very often ALREADY IN REDIS: the check-in-alerts cron
  // warms `pandora:participants:{loc}:{sid}:R1` for every called session, once
  // a minute, and the scan lookup has always resolved badges against it. So
  // count THAT, immediately, and refresh behind it. A number that is up to a
  // minute old and instant beats a fresher one that arrives after the group has
  // walked away.
  const shared = await loadSharedRoster(s.locationId, s.sessionId);
  if (shared) {
    const seeded: RosterCount = {
      checkedIn: shared.filter((p) => !!(p as { checkedIn?: string | null }).checkedIn).length,
      total: shared.length,
      atMs: now,
      stale: false,
    };
    const floored = applyLocalFloor(seeded, credited);
    // Remember it so the next poll is a single Redis read, and refresh from
    // Pandora in the background — nobody waits on that.
    void saveRosterCount(s.locationId, s.sessionId, floored);
    void refreshRosterFromPandora(s);
    return floored;
  }

  const fresh = await refreshRosterFromPandora(s);

  const resolved = resolveRosterCount(fresh, lastKnown, now);
  // The floor is applied BEFORE storing, so the number we remember for this
  // session already includes the scans we know about — a later failed read
  // carries them forward instead of losing them.
  const floored = applyLocalFloor(resolved, credited);
  if (fresh) void saveRosterCount(s.locationId, s.sessionId, floored);
  return floored;
}

async function buildSessionStats(): Promise<SessionStat[]> {
  const sessions: SessionStat[] = [];

  // Racing — currently-called heats per track, from the carry.
  const current = await fetchCurrentRaces("stats");
  for (const [track, data] of Object.entries(current)) {
    if (!data || typeof data !== "object") continue;
    const d = data as {
      sessionId?: number;
      raceType?: string;
      heatNumber?: number;
      scheduledStart?: string;
    };
    if (!d.sessionId) continue;
    sessions.push({
      track,
      raceType: d.raceType ?? "",
      heatNumber: d.heatNumber ?? 0,
      sessionId: d.sessionId,
      scheduledStart: d.scheduledStart ?? "",
      checkedIn: null,
      total: null,
      stale: false,
      locationId: FASTTRAX_LOCATION_ID,
    });
  }

  // HP Arena — currently-called sessions per active center (FM + Naples;
  // sessions/current carries the full session detail, so no schedule
  // lookup needed).
  // ARENA DISCOVERY MUST NOT HOLD UP THE RACING COUNTS.
  //
  // This was a sequential `for await` over the centers, each a live Pandora
  // call with an 8s ceiling — so on a night when Pandora is hanging, two
  // centers could burn 16s before the racing rows even started fetching their
  // rosters. The board aborts its own poll at 20s, so the strip never landed
  // and the desk saw a called heat with no count beside it at all (2026-08-18,
  // owner: "we need that data soon as we call").
  //
  // The centers now run concurrently with each other, on a tighter ceiling: an
  // arena row is a nice-to-have on a racing desk, and a slow one must cost the
  // racing rows nothing.
  const arenaRows = await Promise.all(
    activeArenaCenters().map(async (center): Promise<SessionStat[]> => {
      try {
        // Shared cache + last-known-good. `allowStale` because THIS IS A BOARD:
        // measured 2026-08-19, sessions/current timed out once in five, and the
        // old code returned [] on that — silently emptying every arena row on
        // the strip. A called session from thirty seconds ago beats a blank
        // panel. The alert cron deliberately does NOT pass this flag.
        const { sessions: called } = await calledArenaSessions(center, {
          timeoutMs: 4000,
          allowStale: true,
        });
        const rows: SessionStat[] = [];
        for (const s of called) {
          const sid = String(s.sessionId ?? "");
          if (!sid) continue;
          const activity = classifyArenaSession(s.type ?? "");
          if (!activity) continue; // parties / events — not ticketed
          rows.push({
            track: activityDisplay(activity),
            raceType: "",
            heatNumber: s.heatNumber ?? 0,
            sessionId: sid,
            scheduledStart: s.scheduledStart ?? "",
            checkedIn: null,
            total: null,
            stale: false,
            locationId: center.locationId,
          });
        }
        return rows;
      } catch {
        /* arena stats are best-effort — racing rows still render */
        return [];
      }
    }),
  );
  for (const rows of arenaRows) sessions.push(...rows);

  await Promise.all(
    sessions.map(async (s) => {
      const count = await rosterFor(s);
      s.total = count.total;
      s.checkedIn = count.checkedIn;
      s.stale = count.stale;
    }),
  );

  // Soonest start first so the strip reads left-to-right in time order.
  sessions.sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  return sessions;
}

/** Cached/deduped entry point — see SESSION_STATS_TTL_MS. */
async function getSessionStats(): Promise<SessionStat[]> {
  // No snapshot to check: the session list is read fresh from the carry every
  // time (three Redis GETs) so it can never name a heat that has rolled, and
  // the expensive per-session roster is cached in Redis by rosterFor. All this
  // is left holding is the collapse of concurrent polls on one instance.
  if (sessionStatsInFlight) return sessionStatsInFlight;
  sessionStatsInFlight = buildSessionStats().finally(() => {
    sessionStatsInFlight = null;
  });
  return sessionStatsInFlight;
}

// --------------- GET: Self-test suite ---------------

export async function GET(req: NextRequest) {
  if (!(await auth(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Session stats — returns checked-in counts for CURRENTLY-CALLED
  // sessions across every ticketed attraction: races from races-current
  // plus HP Arena sessions from sessions/current. Identical semantics —
  // a session appears when its SessionAboutToStart fires and drops
  // ~20 min later.
  const action = req.nextUrl.searchParams.get("action");
  if (action === "session-stats") {
    try {
      return NextResponse.json({ sessions: await getSessionStats() });
    } catch {
      return NextResponse.json({ sessions: [] });
    }
  }

  /**
   * SCAN HISTORY — the ring buffer every POST writes to, newest first, with the
   * aggregates alongside so the panel header and its rows cannot disagree.
   *
   * Answers "the board is slow" from the board itself: which badge kinds are
   * slow, how slow, and whether it is every scan or one heat. Read-only, and an
   * empty list is a valid answer (a fresh deploy, or a wiped cache).
   */
  if (action === "scan-history") {
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "100");
    const entries = await readScanHistory(Number.isFinite(limitParam) ? limitParam : 100);
    return NextResponse.json({ entries, stats: summariseScans(entries) });
  }

  const selftest = req.nextUrl.searchParams.get("selftest");
  if (selftest !== "1") {
    return NextResponse.json({ info: "POST to check in, GET ?selftest=1 to run tests" });
  }

  const tests: { name: string; pass: boolean; ms: number; detail?: string }[] = [];

  // 1. Redis connectivity
  {
    const start = Date.now();
    try {
      await redis.ping();
      tests.push({ name: "redis-connectivity", pass: true, ms: Date.now() - start });
    } catch (e) {
      tests.push({
        name: "redis-connectivity",
        pass: false,
        ms: Date.now() - start,
        detail: e instanceof Error ? e.message : "Unknown",
      });
    }
  }

  // 2. Races-current
  {
    const start = Date.now();
    try {
      const current = await fetchCurrentRaces();
      const tracks = Object.entries(current)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: sid ${v?.sessionId ?? "?"}`)
        .join(", ");
      tests.push({
        name: "races-current",
        pass: true,
        ms: Date.now() - start,
        detail: tracks || "No active sessions",
      });
    } catch (e) {
      tests.push({
        name: "races-current",
        pass: false,
        ms: Date.now() - start,
        detail: e instanceof Error ? e.message : "Unknown",
      });
    }
  }

  // 3. QR parse
  {
    const start = Date.now();
    const cases = [
      { input: "FT:12345:67890", expect: true }, // legacy 3-part
      { input: "FT:63000000000021716:99887766", expect: true }, // 17-digit personId
      { input: "FT:12345:67890:49976218", expect: true }, // 4-part w/ participantId
      { input: "HP:TXBSQN0FEKQ11:12345:67890", expect: true }, // arena 4-part
      { input: "HP:TXBSQN0FEKQ11:12345:67890:49976218", expect: true }, // arena 5-part
      { input: "HP:12345:67890:11111", expect: false }, // digits-only "locationId"
      { input: "HP:txbs:12345:67890", expect: false }, // lowercase locationId
      { input: "NOTFT:123:456", expect: false },
      { input: "FT:123", expect: false },
      { input: "FT:abc:456", expect: false },
      { input: "FT:123:456:abc", expect: false }, // bad participantId
      { input: "FT:1:2:3:4", expect: false }, // too many segments
      { input: "", expect: false },
      { input: "0123456789012", expect: false },
    ];
    let passed = 0;
    for (const c of cases) {
      const result = parseCheckinQr(c.input);
      if ((result !== null) === c.expect) passed++;
    }
    tests.push({
      name: "qr-parse",
      pass: passed === cases.length,
      ms: Date.now() - start,
      detail: `${passed}/${cases.length} cases passed`,
    });
  }

  // 4. Headsock detection
  {
    const start = Date.now();
    const mockRows: DepositOverviewRow[] = [
      { OUT_DPK_ID: 12744867, OUT_DPK_NAME: "Credit - Race Weekday", OUT_DPS_AMOUNT: 3 },
    ];
    if (HEADSOCK_DEPOSIT_KIND_ID) {
      mockRows.push({
        OUT_DPK_ID: Number(HEADSOCK_DEPOSIT_KIND_ID),
        OUT_DPK_NAME: "Credit - Headsock",
        OUT_DPS_AMOUNT: 1,
      });
    }
    const found = findHeadsockCredit(mockRows);
    const noHeadsock = findHeadsockCredit([mockRows[0]]);
    const empty = findHeadsockCredit([]);
    const allPass =
      (HEADSOCK_DEPOSIT_KIND_ID ? found !== null && found.balance === 1 : found === null) &&
      noHeadsock === null &&
      empty === null;
    tests.push({
      name: "headsock-detect",
      pass: allPass,
      ms: Date.now() - start,
      detail: HEADSOCK_DEPOSIT_KIND_ID
        ? `HEADSOCK_DEPOSIT_KIND_ID=${HEADSOCK_DEPOSIT_KIND_ID}`
        : "HEADSOCK_DEPOSIT_KIND_ID not set — detection disabled",
    });
  }

  // 5. Back-to-back pick — next 2 heats across tracks, strict-after anchor
  {
    const start = Date.now();
    const mock: HeatCandidate[] = [
      {
        sessionId: "99",
        track: "red",
        raceType: "Starter",
        heatNumber: 5,
        scheduledStart: "2026-07-10T17:45:00Z",
      },
      {
        sessionId: "100",
        track: "blue",
        raceType: "Starter",
        heatNumber: 10,
        scheduledStart: "2026-07-10T18:00:00Z",
      },
      {
        sessionId: "200",
        track: "red",
        raceType: "Intermediate",
        heatNumber: 6,
        scheduledStart: "2026-07-10T18:05:00Z",
      },
      {
        sessionId: "300",
        track: "mega",
        raceType: "Pro",
        heatNumber: 3,
        scheduledStart: "2026-07-10T18:12:00Z",
      },
      {
        sessionId: "101",
        track: "blue",
        raceType: "Starter",
        heatNumber: 11,
        scheduledStart: "2026-07-10T18:17:00Z",
      },
    ];
    const picked = pickNextTwoHeats(mock, "100", "2026-07-10T18:00:00Z");
    const crossTrack =
      picked.length === 2 && picked[0].sessionId === "200" && picked[1].sessionId === "300";
    const excludesSelfAndPast = !picked.some((c) => c.sessionId === "100" || c.sessionId === "99");
    const badAnchorEmpty = pickNextTwoHeats(mock, "100", "").length === 0;
    tests.push({
      name: "back-to-back-pick",
      pass: crossTrack && excludesSelfAndPast && badAnchorEmpty,
      ms: Date.now() - start,
      detail: picked.map((c) => `${c.track} #${c.heatNumber}`).join(", ") || "no candidates",
    });
  }

  // 6. Birthday match — month/day compare incl. leap-day fallback
  {
    const start = Date.now();
    const cases = [
      { born: "1990-07-10", today: "2026-07-10", expect: true }, // exact month/day
      { born: "1990-07-10T00:00:00", today: "2026-07-10", expect: true }, // datetime birthdate
      { born: "1990-07-11", today: "2026-07-10", expect: false }, // different day
      { born: "1990-10-07", today: "2026-07-10", expect: false }, // swapped month/day
      { born: "2000-02-29", today: "2026-02-28", expect: true }, // leap-day, non-leap year
      { born: "2000-02-29", today: "2028-02-28", expect: false }, // leap-day, leap year (Feb 29 exists)
      { born: "2000-02-29", today: "2028-02-29", expect: true }, // leap-day, leap year exact
      { born: null, today: "2026-07-10", expect: false }, // no birthdate on record
      { born: "garbage", today: "2026-07-10", expect: false },
    ];
    let passed = 0;
    for (const c of cases) {
      if (birthdayMatchesToday(c.born, c.today) === c.expect) passed++;
    }
    tests.push({
      name: "birthday-match",
      pass: passed === cases.length,
      ms: Date.now() - start,
      detail: `${passed}/${cases.length} cases passed`,
    });
  }

  return NextResponse.json({
    tests,
    allPassed: tests.every((t) => t.pass),
  });
}
