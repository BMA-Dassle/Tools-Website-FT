import { NextRequest, NextResponse } from "next/server";
import { listAssignmentsForSession } from "@/lib/camera-assign";
import { getSessionBlockSnapshot } from "@/lib/video-block";

/**
 * GET /api/admin/camera-assign/session
 *
 *   (no params)              → next upcoming session across all tracks.
 *   ?track=blue              → only Blue Track (or red/mega) — used when
 *                              a kiosk is dedicated to one track.
 *   ?sessionId={id}          → specific session (test mode). Scans all 3
 *                              track resources for today to resolve.
 *   ?mode=past&days=7        → past sessions across the last N days
 *                              (default 7), descending by time, for the
 *                              test picker.
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const TRACK_RESOURCES = ["Blue Track", "Red Track", "Mega Track"] as const;

function trackSlugToResource(slug: string | null): (typeof TRACK_RESOURCES)[number] | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s === "blue" || s === "blue-track") return "Blue Track";
  if (s === "red" || s === "red-track") return "Red Track";
  if (s === "mega" || s === "mega-track") return "Mega Track";
  return null;
}

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string; // ISO UTC
  type: string;
  heatNumber: number;
}

interface PandoraGuardian {
  personId?: string | number;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  homePhone?: string | null;
  mobilePhone?: string | null;
  acceptMailCommercial?: boolean;
  acceptMailScores?: boolean;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
}

interface Participant {
  personId: string | number;
  firstName: string;
  lastName: string;
  email?: string | null;
  /** Raw Pandora contact fields — we let the client see them so video-
   *  notifications (SMS/email) have what they need at match time. */
  homePhone?: string | null;
  mobilePhone?: string | null;
  phone?: string | null;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
  /** Guardian / parent contact for minors. Pandora is rolling this
   *  out — undefined for old records. Forwarded to the camera-assign
   *  client so it can attach to the assignment + video-notify can
   *  fall back to it when the racer has no usable contact. */
  guardian?: PandoraGuardian | null;
  /** Kart number assigned by SMS-Timing. Populated during/after the
   *  race; null/undefined on upcoming sessions (karts are assigned
   *  close to race time). Passed through so the camera-assign UI can
   *  display it when present. */
  kartNumber?: number | string | null;
  /** True when the participant's bill is paid. Always present when
   *  we call Pandora with `excludeUnpaid=false`; used by the client
   *  to dim/flag unpaid racers so staff knows to collect payment
   *  before binding a camera. */
  paid?: boolean;
}

function etYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function rangeETForDays(backDays: number, forwardDays: number): { startDate: string; endDate: string } {
  // Use a simple UTC day-boundary math — Pandora accepts ISO UTC timestamps
  // and we want to include the full day across the ET window; going
  // UTC ± the whole day captures DST transitions safely without having to
  // resolve the right offset per day.
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const start = new Date(now - backDays * dayMs);
  const end = new Date(now + forwardDays * dayMs);
  // Floor/ceil to UTC day boundaries to keep the windows round.
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

async function fetchSessionsForResource(
  resourceName: string,
  startDate: string,
  endDate: string,
): Promise<(PandoraSession & { resourceName: string })[]> {
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    resourceName,
    startDate,
    endDate,
  }).toString();
  const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  const list: PandoraSession[] = Array.isArray(data?.data) ? data.data : [];
  return list.map((s) => ({ ...s, resourceName }));
}

async function fetchSessionsInWindow(
  resources: readonly string[],
  startDate: string,
  endDate: string,
) {
  const per = await Promise.all(resources.map((r) => fetchSessionsForResource(r, startDate, endDate)));
  return per.flat();
}

/**
 * Pull participants for a session. Cache-first by default — reads
 * the cron-warmed Redis snapshot for an instant load even when
 * Pandora is degraded. The refresh button on the camera-assign UI
 * forwards `?refresh=1` to bypass the cache and force a live
 * Pandora call.
 *
 * Crons (pre-race-tickets every 2 min, checkin-alerts every 1 min)
 * keep the cache warm against the same cache key, so during
 * operating hours the cache-hit path is the common case.
 */
async function fetchParticipants(
  sessionId: string | number,
  forceFresh: boolean,
): Promise<Participant[]> {
  // Camera-assign wants to see unpaid racers too — staff can still bind
  // a camera while payment is being taken. `excludeRemoved` stays on
  // so scratched racers don't pollute the roster.
  const params = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    sessionId: String(sessionId),
    excludeRemoved: "true",
    excludeUnpaid: "false",
  });
  // Refresh button → live Pandora call. Default load → Redis cache
  // (cron-warmed) for instant render even during Pandora outages.
  if (forceFresh) params.set("fresh", "1");
  else params.set("prefer", "cache");

  const res = await fetch(
    `${BASE}/api/pandora/session-participants?${params.toString()}`,
    {
      cache: "no-store",
      // Server-only admin call — internal trust header gets full
      // PII back (firstName/lastName for staff display). Public
      // e-ticket browser calls don't include this header and get
      // a redacted personId-only response.
      headers: { "x-pandora-internal": process.env.SWAGGER_ADMIN_KEY || "" },
    },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as Participant[]) : [];
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get("mode");
    const sessionIdParam = searchParams.get("sessionId");
    const trackParam = searchParams.get("track");
    const daysParam = parseInt(searchParams.get("days") || "7", 10) || 7;
    // Refresh button on the camera-assign page forwards `refresh=1`
    // — bypasses the Redis cache and forces a live Pandora call.
    // Default load is cache-first (cron-warmed Redis) for instant
    // render even during Pandora outages.
    const refresh = searchParams.get("refresh") === "1";

    // Resolve which track resources to query. No track = all three.
    const requestedResource = trackSlugToResource(trackParam);
    const resources = requestedResource ? [requestedResource] : (TRACK_RESOURCES as readonly string[]);

    const now = Date.now();

    // Past mode: broad window (last N days) so staff can demo on a day
    // the track isn't open. We still only want sessions whose start is
    // in the past.
    if (mode === "past") {
      // forwardDays MUST be ≥ 1 so the Pandora query window extends
      // through today. With 0 here, the window ended at today-00:00 UTC
      // (~8 PM yesterday ET during EDT), dropping today's already-run
      // heats from the "Earlier" modal.
      const { startDate, endDate } = rangeETForDays(Math.max(1, Math.min(30, daysParam)), 1);
      const all = await fetchSessionsInWindow(resources, startDate, endDate);
      const past = all
        .filter((s) => new Date(s.scheduledStart).getTime() <= now)
        .sort((a, b) => new Date(b.scheduledStart).getTime() - new Date(a.scheduledStart).getTime());
      return NextResponse.json(
        {
          sessions: past.map((s) => ({
            sessionId: s.sessionId,
            name: s.name,
            scheduledStart: s.scheduledStart,
            track: s.resourceName,
            heatNumber: s.heatNumber,
            type: s.type,
            dateYmd: etYmd(new Date(s.scheduledStart)),
          })),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Live mode: look ~8 days forward so we catch whatever's next, even
    // if today is a closed day. Also look back 1 day so an in-progress
    // session (started <1h ago) still shows up.
    const { startDate, endDate } = rangeETForDays(1, 8);

    // ── Latency optimization ────────────────────────────────────────
    //
    // Both Pandora calls (sessions list + participants) take ~1-2s
    // each. When the client passes `sessionId` (the common case for
    // camera-assign — the heat picker on the page already knows the
    // id), we have everything we need to start the participants /
    // assignments fetches immediately, in parallel with the
    // sessions-list lookup we still need for metadata + validation.
    //
    // This roughly halves perceived load time when an operator picks
    // a heat: was sessions→participants→blocks (~2-3s serial), now
    // max(sessions, participants)→blocks (~1-2s).
    const sessionsPromise = fetchSessionsInWindow(resources, startDate, endDate);
    const earlyParticipantsPromise = sessionIdParam ? fetchParticipants(sessionIdParam, refresh) : null;
    const earlyAssignmentsPromise = sessionIdParam ? listAssignmentsForSession(sessionIdParam) : null;

    const allSessions = await sessionsPromise;

    // Pick the session to surface — either explicitly requested, or the
    // next upcoming one.
    let picked: (PandoraSession & { resourceName: string }) | undefined;
    if (sessionIdParam) {
      picked = allSessions.find((s) => String(s.sessionId) === sessionIdParam);
      if (!picked) {
        // Fall back to a broader search (last 30 days) — past sessions
        // selected from the test picker may be older than the live
        // window. The early participants fetch we kicked off is still
        // valid for past sessions; Pandora's session-participants
        // endpoint isn't time-bounded.
        const wide = rangeETForDays(30, 0);
        const widerSessions = await fetchSessionsInWindow(
          TRACK_RESOURCES as readonly string[],
          wide.startDate,
          wide.endDate,
        );
        picked = widerSessions.find((s) => String(s.sessionId) === sessionIdParam);
      }
      if (!picked) {
        return NextResponse.json(
          { error: `sessionId ${sessionIdParam} not found` },
          { status: 404 },
        );
      }
    } else {
      const upcoming = allSessions
        .filter((s) => new Date(s.scheduledStart).getTime() > now)
        .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime());
      picked = upcoming[0];
    }

    if (!picked) {
      const trackLabel = requestedResource ?? "any track";
      return NextResponse.json(
        {
          session: null,
          participants: [],
          assignments: [],
          note: `No upcoming sessions for ${trackLabel} in the next 8 days.`,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Use the early-fired promises when the client gave us sessionId;
    // otherwise fire them now against the resolved "next upcoming".
    const [participants, assignments] = await Promise.all([
      earlyParticipantsPromise ?? fetchParticipants(picked.sessionId, refresh),
      earlyAssignmentsPromise ?? listAssignmentsForSession(picked.sessionId),
    ]);

    // Map assignments by personId for fast merge in the client.
    // We expose the raw Pandora contact fields so the client can pass
    // them back when scanning — the video-match cron needs them later
    // to deliver the "your video is ready" SMS + email without a
    // second Pandora round-trip.
    const byPid = new Map(assignments.map((a) => [String(a.personId), a]));

    // Fetch block snapshot in one MGET so the client can paint blocked
    // names red on the first render. Falls back to "no blocks" on any
    // error — the block UI is an enhancement, not load-critical.
    let blockSnapshot: {
      sessionBlock: { blocked: boolean; reason?: string; blockedAt?: string };
      personBlocks: Record<string, { blocked: boolean; level?: string; reason?: string; blockedAt?: string }>;
    } = { sessionBlock: { blocked: false }, personBlocks: {} };
    try {
      blockSnapshot = await getSessionBlockSnapshot({
        sessionId: picked.sessionId,
        personIds: participants.map((p) => p.personId),
      });
    } catch (err) {
      console.error("[camera-assign/session] block snapshot failed:", err);
    }

    const enriched = participants.map((p) => ({
      personId: p.personId,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email || undefined,
      mobilePhone: p.mobilePhone || undefined,
      homePhone: p.homePhone || undefined,
      phone: p.phone || undefined,
      acceptSmsCommercial: p.acceptSmsCommercial,
      acceptSmsScores: p.acceptSmsScores,
      // Pass guardian through verbatim — camera-assign client forwards
      // it to /assign which snapshots it onto the assignment record so
      // the video-match cron has it without re-hitting Pandora.
      guardian: p.guardian ?? undefined,
      kartNumber: p.kartNumber ?? undefined,
      paid: p.paid,
      systemNumber: byPid.get(String(p.personId))?.systemNumber,
      assignedAt: byPid.get(String(p.personId))?.assignedAt,
      block: blockSnapshot.personBlocks[String(p.personId)] || { blocked: false },
    }));

    return NextResponse.json(
      {
        session: {
          sessionId: picked.sessionId,
          name: picked.name,
          scheduledStart: picked.scheduledStart,
          track: picked.resourceName,
          heatNumber: picked.heatNumber,
          type: picked.type,
        },
        participants: enriched,
        sessionBlock: blockSnapshot.sessionBlock,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[camera-assign/session]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load session" },
      { status: 500 },
    );
  }
}
