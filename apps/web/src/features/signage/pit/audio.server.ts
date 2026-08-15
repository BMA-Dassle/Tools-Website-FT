import "server-only";

/**
 * The pit's two PA cues — PRE-RACE (the seated group's announcement) and
 * POST-RACE (the finished race's) — pressed from /admin/{token}/pit and
 * played on the venue's Q-SYS Pre/Post Race player via Pandora's proxy
 * (qsys.server.ts; endpoints landed 2026-08-14).
 *
 * ONE PLAY PER TRACK PER CYCLE (owner 2026-08-14). The stamp is claimed NX
 * against the session it plays for BEFORE the play request goes out — two
 * tablets pressing together race for one claim, and only the winner talks to
 * the PA. A play that then FAILS releases the claim, so the button re-arms
 * and the press can retry (same NX-first / DEL-on-failure shape as
 * return-announce.server.ts, and for the same reason: a cue that silently
 * never happened is the failure staff can't see). The stamp resets itself:
 * the next cycle is a different session, which is a different key.
 *
 * POST DOUBLES AS "RACE RETURNED" (owner 2026-08-14: "you dont need the race
 * returned button as the post play will double as that"). A SUCCESSFUL post
 * play writes the same pitted stamp the check-in board's pit-lane button
 * writes (markRacePitted), so the wall's hold machine (pit-board.ts) is
 * unchanged — the release arrives with the announcement. A FAILED play
 * releases nothing: the hold stands, and the check-in button remains the
 * manual override for a night the PA cannot play.
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
import { playQsysCue } from "./qsys.server";

const VENUE = "FT";

/** Outlives any race night; short enough that Redis stays display state —
 *  the durable record is the Neon event row written on the claim. */
const STAMP_TTL_SECONDS = 12 * 3600;

export type PitCue = "pre" | "post";

/** One played cue: when, and how long the clip is when the player said in
 *  time (the /play reply is held ~0.6s so it usually can). */
export interface CueStamp {
  atMs: number;
  durationS: number | null;
}

function cueKey(cue: PitCue, sessionId: string): string {
  return `pit:audio:${cue}:${sessionId}`;
}

/** Stamps started life as a bare epoch-ms string and grew a duration field
 *  the day the Pandora endpoints landed — both shapes stay readable for the
 *  12h a pre-upgrade stamp can still be live. */
function parseStamp(raw: string | null): CueStamp | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return { atMs: n, durationS: null };
  try {
    const p = JSON.parse(raw) as { atMs?: number; durationS?: number | null };
    if (typeof p.atMs !== "number" || !Number.isFinite(p.atMs)) return null;
    return {
      atMs: p.atMs,
      durationS:
        typeof p.durationS === "number" && Number.isFinite(p.durationS) ? p.durationS : null,
    };
  } catch {
    return null;
  }
}

/** When (and how long) a cue played for a session, or null. Swallows —
 *  reads ride the feed. */
export async function readCueStamp(cue: PitCue, sessionId: string): Promise<CueStamp | null> {
  if (!sessionId) return null;
  try {
    return parseStamp(await redis.get(cueKey(cue, sessionId)));
  } catch {
    return null;
  }
}

/** Both cues for one session — what the control board's GET carries. */
export interface PitCueStamps {
  pre: CueStamp | null;
  post: CueStamp | null;
}

export async function readCueStamps(sessionId: string): Promise<PitCueStamps> {
  const [pre, post] = await Promise.all([
    readCueStamp("pre", sessionId),
    readCueStamp("post", sessionId),
  ]);
  return { pre, post };
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
 * Claim the one-shot, fire the PA, and settle the stamp.
 *
 * Claim-first so concurrent presses can't both reach the player; on a failed
 * play the claim is DELeted so the next press retries. On success the stamp
 * is rewritten with the clip duration the player reported — a plain
 * overwrite, safe because the claim is already ours.
 */
async function claimAndPlay(
  track: TrackKey,
  cue: PitCue,
  sessionId: string,
): Promise<
  | { outcome: "played"; atMs: number }
  | { outcome: "already"; atMs: number | null }
  | { outcome: "failed"; error: string }
> {
  const nowMs = Date.now();
  const key = cueKey(cue, sessionId);
  const claimed = await redis
    .set(key, JSON.stringify({ atMs: nowMs, durationS: null }), "EX", STAMP_TTL_SECONDS, "NX")
    .catch(() => null);
  if (claimed !== "OK") {
    const stamp = await readCueStamp(cue, sessionId);
    return { outcome: "already", atMs: stamp?.atMs ?? null };
  }

  const play = await playQsysCue(track, cue);
  if (!play.ok) {
    // Release the claim — the cue never sounded, so the press must be
    // repeatable. A DEL that itself fails leaves a stamp the TTL clears.
    await redis.del(key).catch(() => void 0);
    return { outcome: "failed", error: play.error ?? "the PA did not start the cue" };
  }

  if (play.durationS != null) {
    await redis
      .set(key, JSON.stringify({ atMs: nowMs, durationS: play.durationS }), "EX", STAMP_TTL_SECONDS)
      .catch(() => void 0);
  }
  return { outcome: "played", atMs: nowMs };
}

/**
 * Play the PRE-RACE cue for whatever group is in the track's holding.
 *
 * The Neon row is the durable record and is written only on a fresh, PLAYED
 * claim — awaited and uncaught, same posture as every briefing event: a
 * staff action whose record cannot land should fail loudly, not proceed
 * unrecorded. The room on the row is the room the group was briefed in.
 */
export async function playPreRace(track: TrackKey): Promise<PlayCueResult> {
  const lane = await readPitLane(track);
  const holding = lane.holding;
  if (!holding) {
    return { ok: false, error: "no group is in holding — pre-race arms when a group is seated" };
  }

  const result = await claimAndPlay(track, "pre", holding.sessionId);
  if (result.outcome === "failed") return { ok: false, error: result.error };
  if (result.outcome === "already") {
    return {
      ok: true,
      alreadyPlayed: true,
      atMs: result.atMs ?? undefined,
      sessionId: holding.sessionId,
    };
  }

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
  return { ok: true, atMs: result.atMs, sessionId: holding.sessionId };
}

/**
 * Play the POST-RACE cue for the finished race — and release the lane.
 *
 * Refuses while the race is still out: post arms at the finish marker, and a
 * stamp written early would lock the one play this cycle gets. Only a play
 * that actually SOUNDED writes the pitted stamp (markRacePitted) — that is
 * what flips the wall boards from HOLD back to seating, and an unheard
 * announcement must not reopen the lane. A repeat press does NOT re-pit —
 * the first press already released it, and a second stamp could mask a NEW
 * hold if the next race finished in between.
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

  const result = await claimAndPlay(track, "post", racing.sessionId);
  if (result.outcome === "failed") return { ok: false, error: result.error };
  if (result.outcome === "already") {
    return {
      ok: true,
      alreadyPlayed: true,
      atMs: result.atMs ?? undefined,
      sessionId: racing.sessionId,
    };
  }

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

  return { ok: true, atMs: result.atMs, sessionId: racing.sessionId };
}
