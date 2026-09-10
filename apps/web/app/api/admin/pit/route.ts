import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { afterResponse } from "~/features/signage/after-response.server";
import {
  nudgeStaySeated,
  playPostRace,
  playPreRace,
  postRaceGate,
  readClipLengths,
  readCueStamps,
} from "~/features/signage/pit/audio.server";
import { readPitLanes } from "~/features/signage/pit/lane.server";
import { PANDORA_QSYS_SOCKET_URL } from "~/features/signage/pit/qsys.server";
import { readQsysTruth, type QsysTruth } from "~/features/signage/pit/qsys-truth.server";
import type { ClipLengths, PitCueStamps, PostRaceGate } from "~/features/signage/pit/audio.server";
import { paBusyZoneFor, type PitLanes } from "~/features/signage/pit/pit-board";
import type { TrackKey } from "~/features/signage/track";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

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
/**
 * A press can now HOLD for the other pit (cue-sync.ts: up to 5s waiting for
 * the partner's press, then the play's own ~1–8s budget; a joiner waits up to
 * 15s for the leader's outcome). Well inside this, and well above the
 * platform default a held press would otherwise trip.
 */
export const maxDuration = 30;

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function authed(req: NextRequest): Promise<boolean> {
  return isAdminApiRequest(req);
}

const PIT_TRACKS: TrackKey[] = ["blue", "red", "mega"];

export interface PitBoardResponse {
  now: number;
  lanes: PitLanes;
  /** Cue stamps for every session the lanes mention, keyed by sessionId
   *  (TEXT — BMI ids exceed Number.MAX_SAFE_INTEGER, house rule). */
  audio: Record<string, PitCueStamps>;
  /** The Q-SYS player's zone state — Pandora's WebSocket cache cross-checked
   *  against the Core (qsys-truth.server.ts). The tablet's countdown FALLBACK
   *  when its own socket is down (the owner prefers the direct feed,
   *  2026-08-14), and the source of `paBusy` below. Null when nothing can be
   *  read; the controls stand without it. */
  qsys: QsysTruth | null;
  /**
   * WHICH ZONE BLOCKS A PRESS ON EACH TRACK, or null — THE SERVER'S VERDICT,
   * not the tablet's (2026-09-10). The station used to derive this from its
   * own socket frame, and Pandora's relay serves that frame from the same
   * cache that froze with mega "playing" for an hour: every control read
   * "PA busy · mega" and nothing on the tablet could know better. The server
   * can — it asks the Core — so the button now draws what the press would be
   * told. The stay-seated loop never counts (paBusyZoneFor).
   */
  paBusy: Record<TrackKey, string | null>;
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
  /** Each clip's length as the player last reported it (null until a clip's
   *  first ever play) — what the pre button's "race ending" blink counts
   *  against. */
  clipLengths: ClipLengths;
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const lanes = await readPitLanes();
  // Second driver for the stay-seated loop, beside the pulse — a night the
  // walls are off but the tablet is up still nags. Same NX throttle, so the
  // two drivers can never double-play.
  afterResponse(() => nudgeStaySeated(lanes));
  /**
   * EVERY SLOT, because the client reads stamps for every slot.
   *
   * This collected only `holding` and `racing`, from before the lane grew its
   * other two stages. The client resolves the staged group as
   * `holding ?? karts` and the returning group as `pitIn` — so a group sitting
   * IN KARTS had no entry in `audio` at all, its pre stamp came back undefined,
   * and the station offered "Play pre-race" for a cue that had already played
   * (owner 2026-08-15: Red 17 showed pre-done on the wall and still-due here).
   * The wall was right: it reads the stamp directly.
   *
   * `pitIn` had the same hole, which is the post half of the same bug.
   */
  const sessionIds = new Set<string>();
  for (const lane of Object.values(lanes)) {
    if (lane.holding?.sessionId) sessionIds.add(lane.holding.sessionId);
    if (lane.karts?.sessionId) sessionIds.add(lane.karts.sessionId);
    if (lane.racing?.sessionId) sessionIds.add(lane.racing.sessionId);
    if (lane.pitIn?.sessionId) sessionIds.add(lane.pitIn.sessionId);
  }
  const audio: Record<string, PitCueStamps> = {};
  const postGate: Record<TrackKey, PostRaceGate | null> = { blue: null, red: null, mega: null };
  // The PA read rides EVERY poll now — it used to be skipped (?qsys=0) while
  // the tablet held the player's socket, but the busy verdict moved server-
  // side (see `paBusy`) and it has to come from a read the server vouches
  // for. readQsysTruth memoises for 2s, so the 1s poll costs a Redis GET on
  // the beats between Pandora calls.
  const [qsys, clipLengths] = await Promise.all([
    readQsysTruth(),
    readClipLengths(),
    ...[...sessionIds].map(async (sid) => {
      audio[sid] = await readCueStamps(sid);
    }),
    ...PIT_TRACKS.map(async (track) => {
      // The gate is asked about the group in the PIT — the ones post-race would
      // actually be announcing (2026-08-15). Occupying that slot is the whole
      // arming condition now, so there is no finish stamp left to test.
      const returning = lanes[track].pitIn;
      if (returning) {
        postGate[track] = await postRaceGate(returning.sessionId);
      }
    }),
  ]);

  const paBusy: Record<TrackKey, string | null> = { blue: null, red: null, mega: null };
  for (const track of PIT_TRACKS) paBusy[track] = paBusyZoneFor(track, qsys?.zones ?? null);

  const body: PitBoardResponse = {
    now: Date.now(),
    lanes,
    audio,
    qsys,
    paBusy,
    socketUrl: process.env.PIT_QSYS_SOCKET_URL || PANDORA_QSYS_SOCKET_URL,
    postGate,
    clipLengths,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
