import "server-only";

/**
 * The pit's two PA cues — PRE-RACE (the seated group's announcement) and
 * POST-RACE (the finished race's) — pressed from /admin/{token}/pit.
 *
 * ONE PLAY PER TRACK PER CYCLE (owner 2026-08-14). A cue's stamp is claimed
 * NX against the session it played for, so a double-tap, two open tablets, or
 * a retried request can never fire the announcement twice. The stamp resets
 * itself: the next cycle is a different session, which is a different key.
 *
 * POST DOUBLES AS "RACE RETURNED" (owner 2026-08-14: "you dont need the race
 * returned button as the post play will double as that"). Playing post writes
 * the same pitted stamp the check-in board's pit-lane button writes
 * (markRacePitted), so the wall's hold machine (pit-board.ts) is unchanged —
 * the release just arrives with the announcement. The check-in button stays
 * as the manual override for a night the PA cannot play.
 *
 * ARMING RULES the API enforces server-side, so a stale tablet cannot stamp
 * the wrong cycle:
 *
 *   pre    a group is in HOLDING (they are the ones being announced)
 *   post   the racing group's FINISH marker has landed
 *
 * WHO EACH CUE PLAYED FOR is resolved from the lane at press time — the same
 * posture as markRacePitted, which takes a track and never trusts a client
 * sessionId.
 */
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";
import { recordBriefingEvent } from "../briefing/events-db";
import { sessionBriefed } from "../briefing/state.server";
import type { TrackKey } from "../track";
import { markRacePitted, readPitLane } from "./lane.server";

const VENUE = "FT";

/** Outlives any race night; short enough that Redis stays display state —
 *  the durable record is the Neon event row written on the claim. */
const STAMP_TTL_SECONDS = 12 * 3600;

export type PitCue = "pre" | "post";

function cueKey(cue: PitCue, sessionId: string): string {
  return `pit:audio:${cue}:${sessionId}`;
}

/** When a cue played for a session, or null. Swallows — reads ride the feed. */
export async function readCueStamp(cue: PitCue, sessionId: string): Promise<number | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(cueKey(cue, sessionId));
    if (!raw) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Both cues for one session — what the control board's GET carries. */
export interface PitCueStamps {
  preAtMs: number | null;
  postAtMs: number | null;
}

export async function readCueStamps(sessionId: string): Promise<PitCueStamps> {
  const [preAtMs, postAtMs] = await Promise.all([
    readCueStamp("pre", sessionId),
    readCueStamp("post", sessionId),
  ]);
  return { preAtMs, postAtMs };
}

/**
 * THE Q-SYS SEAM. The venue's cues live on the Q-SYS Core today; the trigger
 * endpoints are coming (owner 2026-08-14: "Ill give you endpoints later").
 * Until they land this is a deliberate no-op — the press records the cue and
 * staff fire the audio from the Q-SYS panel as they do now — and when they
 * arrive, playback plugs in HERE and nowhere else.
 */
async function triggerPitCue(_track: TrackKey, _cue: PitCue): Promise<void> {
  /* not wired yet — see the header */
}

export interface PlayCueResult {
  ok: boolean;
  error?: string;
  /** The stamp — the fresh one, or the existing one on a repeat press. */
  atMs?: number;
  /** The press lost the NX claim: the cue already played for this cycle.
   *  Not an error — the button was simply pressed twice. */
  alreadyPlayed?: boolean;
  sessionId?: string;
}

/**
 * Play the PRE-RACE cue for whatever group is in the track's holding.
 *
 * The Neon row is the durable record and is written only on a fresh claim —
 * awaited and uncaught, same posture as every briefing event: a staff action
 * whose record cannot land should fail loudly, not proceed unrecorded. The
 * room on the row is the room the group was briefed in.
 */
export async function playPreRace(track: TrackKey): Promise<PlayCueResult> {
  const lane = await readPitLane(track);
  const holding = lane.holding;
  if (!holding) {
    return { ok: false, error: "no group is in holding — pre-race arms when a group is seated" };
  }

  const nowMs = Date.now();
  const claimed = await redis
    .set(cueKey("pre", holding.sessionId), String(nowMs), "EX", STAMP_TTL_SECONDS, "NX")
    .catch(() => null);
  if (claimed !== "OK") {
    const atMs = await readCueStamp("pre", holding.sessionId);
    return { ok: true, alreadyPlayed: true, atMs: atMs ?? undefined, sessionId: holding.sessionId };
  }

  await triggerPitCue(track, "pre");

  const room =
    holding.room ?? (await sessionBriefed(holding.sessionId).catch(() => null))?.room ?? null;
  if (room) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track,
      sessionId: holding.sessionId,
      heatNumber: holding.heatNumber,
      raceType: holding.raceType,
      tier: null,
      action: "audio-pre",
    });
  }
  return { ok: true, atMs: nowMs, sessionId: holding.sessionId };
}

/**
 * Play the POST-RACE cue for the finished race — and release the lane.
 *
 * Refuses while the race is still out: post arms at the finish marker, and a
 * stamp written early would lock the one play this cycle gets. On a fresh
 * claim it also writes the pitted stamp (markRacePitted), which is what flips
 * the wall boards from HOLD back to seating. A repeat press does NOT re-pit —
 * the first press already released the lane, and a second stamp could mask a
 * NEW hold if the next race finished in between.
 */
export async function playPostRace(track: TrackKey): Promise<PlayCueResult> {
  const lane = await readPitLane(track);
  const racing = lane.racing;
  if (!racing) {
    return { ok: false, error: "no race is out on that track — nothing to play post-race for" };
  }
  if (racing.finishedAtMs == null) {
    return { ok: false, error: "the race hasn't finished — post-race arms at the finish" };
  }

  const nowMs = Date.now();
  const claimed = await redis
    .set(cueKey("post", racing.sessionId), String(nowMs), "EX", STAMP_TTL_SECONDS, "NX")
    .catch(() => null);
  if (claimed !== "OK") {
    const atMs = await readCueStamp("post", racing.sessionId);
    return { ok: true, alreadyPlayed: true, atMs: atMs ?? undefined, sessionId: racing.sessionId };
  }

  await triggerPitCue(track, "post");

  const room = (await sessionBriefed(racing.sessionId).catch(() => null))?.room ?? null;
  if (room) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track,
      sessionId: racing.sessionId,
      heatNumber: racing.heatNumber,
      raceType: null,
      tier: null,
      action: "audio-post",
    });
  }

  // The release. markRacePitted resolves the racing group itself and writes
  // its own insurance row — one code path for this stamp, whoever presses.
  await markRacePitted(track);

  return { ok: true, atMs: nowMs, sessionId: racing.sessionId };
}
