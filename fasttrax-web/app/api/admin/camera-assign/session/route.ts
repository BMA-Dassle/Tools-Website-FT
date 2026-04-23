import { NextRequest, NextResponse } from "next/server";
import { listAssignmentsForSession } from "@/lib/camera-assign";

/**
 * GET /api/admin/camera-assign/session
 *
 *   (no params)              → next upcoming session (across all tracks)
 *                              with its participants + any prior camera
 *                              assignments.
 *   ?sessionId={id}&track=Red Track
 *                            → specific session (test mode). Need both
 *                              sessionId AND the resource name because the
 *                              Pandora sessions endpoint is resource-
 *                              scoped.
 *   ?mode=past               → today's past sessions (ascending by time)
 *                              for the test picker.
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const TRACK_RESOURCES = ["Blue Track", "Red Track", "Mega Track"] as const;

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string; // ISO UTC
  type: string;
  heatNumber: number;
}

interface Participant {
  personId: string | number;
  firstName: string;
  lastName: string;
}

function todayETRange(): { startDate: string; endDate: string } {
  // Mirror the cron pattern: today 00:00 → tomorrow 00:00 ET as ISO UTC
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const ymd = fmt.format(now);
  const startLocal = new Date(`${ymd}T00:00:00-04:00`); // ET (DST-naive but close enough for a daily window)
  const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000);
  return {
    startDate: startLocal.toISOString(),
    endDate: endLocal.toISOString(),
  };
}

async function fetchSessionsForResource(resourceName: string): Promise<(PandoraSession & { resourceName: string })[]> {
  const { startDate, endDate } = todayETRange();
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

async function fetchAllTodaySessions() {
  const per = await Promise.all(TRACK_RESOURCES.map(fetchSessionsForResource));
  return per.flat();
}

async function fetchParticipants(sessionId: string | number): Promise<Participant[]> {
  const res = await fetch(
    `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}`,
    { cache: "no-store" },
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

    const allSessions = await fetchAllTodaySessions();
    // Past list — just sessions whose scheduledStart has passed
    const now = Date.now();
    const pastSessions = allSessions
      .filter((s) => new Date(s.scheduledStart).getTime() <= now)
      .sort((a, b) => new Date(b.scheduledStart).getTime() - new Date(a.scheduledStart).getTime());

    if (mode === "past") {
      return NextResponse.json(
        { sessions: pastSessions.map((s) => ({
            sessionId: s.sessionId,
            name: s.name,
            scheduledStart: s.scheduledStart,
            track: s.resourceName,
            heatNumber: s.heatNumber,
            type: s.type,
          })),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Pick the session to surface — either explicitly requested, or the
    // next upcoming one.
    let picked: (PandoraSession & { resourceName: string }) | undefined;
    if (sessionIdParam) {
      picked = allSessions.find((s) => String(s.sessionId) === sessionIdParam);
      if (!picked) {
        return NextResponse.json(
          { error: `sessionId ${sessionIdParam} not found in today's schedule` },
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
      return NextResponse.json(
        { session: null, participants: [], assignments: [], note: "No upcoming sessions today." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [participants, assignments] = await Promise.all([
      fetchParticipants(picked.sessionId),
      listAssignmentsForSession(picked.sessionId),
    ]);

    // Map assignments by personId for fast merge in the client
    const byPid = new Map(assignments.map((a) => [String(a.personId), a]));
    const enriched = participants.map((p) => ({
      personId: p.personId,
      firstName: p.firstName,
      lastName: p.lastName,
      cameraNumber: byPid.get(String(p.personId))?.cameraNumber,
      assignedAt: byPid.get(String(p.personId))?.assignedAt,
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
