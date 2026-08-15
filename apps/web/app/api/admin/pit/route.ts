import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  playPostRace,
  playPreRace,
  postRaceGate,
  readCueStamps,
} from "~/features/signage/pit/audio.server";
import { readPitLanes } from "~/features/signage/pit/lane.server";
import { PANDORA_QSYS_SOCKET_URL, readQsysLive } from "~/features/signage/pit/qsys.server";
import type { PitCueStamps, PostRaceGate } from "~/features/signage/pit/audio.server";
import type { QsysLiveState } from "~/features/signage/pit/qsys.server";
import type { PitLanes } from "~/features/signage/pit/pit-board";
import type { TrackKey } from "~/features/signage/track";

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

const PIT_TRACKS: TrackKey[] = ["blue", "red", "mega"];

export interface PitBoardResponse {
  now: number;
  lanes: PitLanes;
  /** Cue stamps for every session the lanes mention, keyed by sessionId
   *  (TEXT — BMI ids exceed Number.MAX_SAFE_INTEGER, house rule). */
  audio: Record<string, PitCueStamps>;
  /** The Q-SYS player's zone state from Pandora's WebSocket cache — the
   *  tablet's FALLBACK when its own socket to the Core is down (the owner
   *  prefers the direct feed, 2026-08-14). Null when Pandora can't be read;
   *  the controls stand without it. */
  qsys: QsysLiveState | null;
  /** The push feed the tablet binds to. Defaults to PANDORA'S WSS RELAY of
   *  the Core's feed (no auth, works from an https page with no tablet
   *  settings); PIT_QSYS_SOCKET_URL overrides it — e.g. ws://<core>:8001/ws
   *  for a LAN tablet pointed straight at the Core (that path needs the
   *  per-site mixed-content allowance). Server env, so never a rebuild. */
  socketUrl: string | null;
  /** May post-race play right now, per track — the SAME verdict the press
   *  will get (audio.server.ts postRaceGate), shipped so the button can say
   *  why it's held instead of refusing on press. Null when moot (no finished
   *  race on that track). */
  postGate: Record<TrackKey, PostRaceGate | null>;
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
  const postGate: Record<TrackKey, PostRaceGate | null> = { blue: null, red: null, mega: null };
  // ?qsys=0 — the tablet holds the player's socket itself, so the poll skips
  // the Pandora live read and stays pure Redis. This is what lets the client
  // poll every second.
  const wantQsys = req.nextUrl.searchParams.get("qsys") !== "0";
  const [qsys] = await Promise.all([
    wantQsys ? readQsysLive() : Promise.resolve(null),
    ...[...sessionIds].map(async (sid) => {
      audio[sid] = await readCueStamps(sid);
    }),
    ...PIT_TRACKS.map(async (track) => {
      const racing = lanes[track].racing;
      if (racing && racing.finishedAtMs != null) {
        postGate[track] = await postRaceGate(racing.sessionId);
      }
    }),
  ]);

  const body: PitBoardResponse = {
    now: Date.now(),
    lanes,
    audio,
    qsys,
    socketUrl: process.env.PIT_QSYS_SOCKET_URL || PANDORA_QSYS_SOCKET_URL,
    postGate,
  };
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
