import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { playPostRace, playPreRace, readCueStamps } from "~/features/signage/pit/audio.server";
import { readPitLanes } from "~/features/signage/pit/lane.server";
import type { PitCueStamps } from "~/features/signage/pit/audio.server";
import type { PitLanes } from "~/features/signage/pit/pit-board";

/**
 * The pit control station's API (/admin/{token}/pit).
 *
 * A thin shell, same shape as /api/admin/briefing: parse, authorise, delegate.
 * GET is the board — every track's resolved lane plus the cue stamps for the
 * sessions those lanes mention. POST is the two presses, track-keyed like
 * "pitted": the server resolves WHICH session a cue plays for from the lane
 * at press time, so a stale tablet can never stamp the wrong cycle
 * (pit/audio.server.ts owns the rules).
 *
 * Auth: middleware gates every /api/admin/* path on ADMIN_CAMERA_TOKEN. The
 * inline check repeats it because the post press releases a hold that guests
 * see on a wall — same reasoning as the briefing route.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected) return false;
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  return token === expected;
}

export interface PitBoardResponse {
  now: number;
  lanes: PitLanes;
  /** Cue stamps for every session the lanes mention, keyed by sessionId
   *  (TEXT — BMI ids exceed Number.MAX_SAFE_INTEGER, house rule). */
  audio: Record<string, PitCueStamps>;
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const lanes = await readPitLanes();
  const sessionIds = new Set<string>();
  for (const lane of Object.values(lanes)) {
    if (lane.holding?.sessionId) sessionIds.add(lane.holding.sessionId);
    if (lane.racing?.sessionId) sessionIds.add(lane.racing.sessionId);
  }
  const audio: Record<string, PitCueStamps> = {};
  await Promise.all(
    [...sessionIds].map(async (sid) => {
      audio[sid] = await readCueStamps(sid);
    }),
  );

  const body: PitBoardResponse = { now: Date.now(), lanes, audio };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { action?: string; track?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const track =
    body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
  if (!track) {
    return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
  }

  if (body.action === "audio-pre") {
    const result = await playPreRace(track);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }
  if (body.action === "audio-post") {
    const result = await playPostRace(track);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
