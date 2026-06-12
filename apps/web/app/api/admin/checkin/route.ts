import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { parseCheckinQr } from "@/lib/qr-checkin";
import {
  getDepositOverview,
  addDeposit,
  DEPOSIT_KIND,
  type DepositOverviewRow,
} from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import { ARENA_RESOURCES, HP_FM_LOCATION_ID } from "~/features/arena-tickets/constants";
import { activityDisplay, classifyArenaSession } from "~/features/arena-tickets/types";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const HEADSOCK_DEPOSIT_KIND_ID = DEPOSIT_KIND.HEADSOCK;

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

function auth(req: NextRequest): boolean {
  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-admin-token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  return !!expected && token === expected;
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

async function fetchCurrentRaces(req: NextRequest): Promise<CurrentRaces> {
  try {
    // Hit Pandora live (with 5s upstream timeout + fallback to Redis on
    // failure). The checkin page needs fresh race data — operators can't
    // wait 60s for the cron to warm Redis.
    const origin = req.nextUrl.origin;
    const res = await fetch(`${origin}/api/pandora/races-current`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    return (await res.json()) as CurrentRaces;
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
 * the LIVE called signal from Pandora's sessions/current (entries
 * appear at SessionAboutToStart and drop ~20 min later, mirroring
 * races-current), with the scheduled-time window (−60/+30 min) as a
 * fallback so early walk-up check-ins and a degraded Pandora never
 * dead-end the desk. No headsock (racing-only). Out-of-window scans
 * look up the guest's NEXT arena session (Pandora sessions/next) so
 * staff can say "come back at X" instead of a blank yellow.
 */
const ARENA_EARLY_MIN = 60;
const ARENA_LATE_MIN = 30;

/** Live called arena sessions at this location — sessionIds whose
 *  SessionAboutToStart fired in the last ~20 min. Empty set on any
 *  failure (callers fall back to the time window). */
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

  // Green gate: the session was just called (live signal, drops ~20 min
  // after call) OR we're inside the scheduled-time window (fallback for
  // early walk-ups + degraded Pandora notifications).
  const calledNow = calledIds.has(sessionId);
  let inWindow = false;
  if (session?.scheduledStart) {
    const startMs = new Date(session.scheduledStart).getTime();
    if (!isNaN(startMs)) {
      const minsUntil = (startMs - Date.now()) / 60_000;
      inWindow = minsUntil <= ARENA_EARLY_MIN && minsUntil >= -ARENA_LATE_MIN;
    }
  }

  if (!calledNow && !inWindow) {
    // Yellow card — outside the check-in window and not called. Look up
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

  const checkinResult = await checkInViaPandora(personId, sessionId, locationId);
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

export async function POST(req: NextRequest) {
  if (!auth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { personId?: string; sessionId?: string; raw?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let personId = body.personId;
  let sessionId = body.sessionId;
  // Stable participantId off a 4-part e-ticket QR (FT:pid:sid:participantId).
  // Drives move-resilient live-session resolution below; null for 3-part QRs
  // and bare paper QRs, which keep their existing behavior.
  let qrParticipantId: string | null = null;
  // Explicit locationId off an HP-prefixed (arena) QR. Null for all FT
  // QRs and paper QRs — those stay on the racing path below.
  let qrLocationId: string | null = null;

  if (body.raw) {
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
    return handleArenaScan(req, qrLocationId, personId, sessionId, qrParticipantId);
  }

  // Get races-current first (needed for both e-ticket QR and paper QR paths)
  const current = await fetchCurrentRaces(req);

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
    if (HEADSOCK_DEPOSIT_KIND_ID) {
      try {
        const deposits = await getDepositOverview(personId, FASTTRAX_LOCATION_ID);
        const hs = findHeadsockCredit(deposits);
        if (hs) {
          headsock.detected = true;
          headsock.balance = hs.balance;
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
      } catch {
        // Deposit read failed — don't block check-in
      }
    }

    // Await Pandora check-in — returns guest photo as base64
    const checkinResult = await checkInViaPandora(personId, sessionId);
    const checkinGuest = checkinResult.guest;

    const guestResponse = {
      firstName: checkinGuest?.firstName || guest?.firstName || "",
      lastName: checkinGuest?.lastName || guest?.lastName || "",
      pictureUrl: checkinGuest?.pic ?? null,
    };

    return NextResponse.json({
      success: checkinResult.success,
      guest: guestResponse,
      session: { track, raceType, heatNumber, scheduledStart },
      currentlyCheckingIn,
      headsock,
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
  });
}

// --------------- GET: Self-test suite ---------------

export async function GET(req: NextRequest) {
  if (!auth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Session stats — returns checked-in counts for CURRENTLY-CALLED
  // sessions across every ticketed attraction: races from races-current
  // plus HP Arena sessions from sessions/current. Identical semantics —
  // a session appears when its SessionAboutToStart fires and drops
  // ~20 min later.
  const action = req.nextUrl.searchParams.get("action");
  if (action === "session-stats") {
    interface SessionStat {
      track: string;
      raceType: string;
      heatNumber: number;
      sessionId: number | string;
      scheduledStart: string;
      checkedIn: number;
      total: number;
      /** Locates the participant fetch — arena rows count at HP FM. */
      locationId: string;
    }
    try {
      const sessions: SessionStat[] = [];

      // Racing — currently-called heats per track.
      const current = await fetchCurrentRaces(req);
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
          checkedIn: 0,
          total: 0,
          locationId: FASTTRAX_LOCATION_ID,
        });
      }

      // HP Arena — currently-called sessions (sessions/current carries
      // the full session detail, so no schedule lookup needed).
      try {
        const res = await fetch(`${PANDORA_BASE}/v2/bmi/sessions/current/${HP_FM_LOCATION_ID}`, {
          headers: pandoraHeaders(),
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const json = await res.json();
          const called = Array.isArray(json?.data)
            ? (json.data as {
                sessionId?: string;
                type?: string;
                heatNumber?: number;
                scheduledStart?: string | null;
              }[])
            : [];
          for (const s of called) {
            const sid = String(s.sessionId ?? "");
            if (!sid) continue;
            const activity = classifyArenaSession(s.type ?? "");
            if (!activity) continue; // parties / events — not ticketed
            sessions.push({
              track: activityDisplay(activity),
              raceType: "",
              heatNumber: s.heatNumber ?? 0,
              sessionId: sid,
              scheduledStart: s.scheduledStart ?? "",
              checkedIn: 0,
              total: 0,
              locationId: HP_FM_LOCATION_ID,
            });
          }
        }
      } catch {
        /* arena stats are best-effort — racing rows still render */
      }

      await Promise.all(
        sessions.map(async (s) => {
          try {
            const pRes = await fetch(
              `${PANDORA_BASE}/v2/bmi/session/${s.locationId}/${s.sessionId}/participants?excludeRemoved=true`,
              { headers: pandoraHeaders(), cache: "no-store", signal: AbortSignal.timeout(5000) },
            );
            if (!pRes.ok) return;
            const pData = await pRes.json();
            const list = Array.isArray(pData?.data) ? pData.data : [];
            s.total = list.length;
            s.checkedIn = list.filter((p: { checkedIn?: string | null }) => !!p.checkedIn).length;
          } catch {
            /* silent */
          }
        }),
      );

      // Soonest start first so the strip reads left-to-right in time order.
      sessions.sort(
        (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
      );
      return NextResponse.json({ sessions });
    } catch {
      return NextResponse.json({ sessions: [] });
    }
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
      const current = await fetchCurrentRaces(req);
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

  return NextResponse.json({
    tests,
    allPassed: tests.every((t) => t.pass),
  });
}
