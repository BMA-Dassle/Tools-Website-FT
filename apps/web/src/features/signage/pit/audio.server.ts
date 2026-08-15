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
import { readBriefingRooms, sessionBriefed } from "../briefing/state.server";
import type { TrackKey } from "../track";
import { cueKey, readCueStamp, type PitCue } from "./audio-stamps.server";
import { markInKarts, markRacePitted, readPitLane } from "./lane.server";
import { playQsysCue, readQsysLive } from "./qsys.server";

// The stamp read side lives in audio-stamps.server.ts (lane.server needs it
// too — post played = returned — and importing it from here would be a
// cycle). Re-exported so this module stays the one import for cue callers.
export {
  readCueStamp,
  readCueStamps,
  type CueStamp,
  type PitCue,
  type PitCueStamps,
} from "./audio-stamps.server";

const VENUE = "FT";

/** Outlives any race night; short enough that Redis stays display state —
 *  the durable record is the Neon event row written on the claim. */
const STAMP_TTL_SECONDS = 12 * 3600;

/**
 * ONE CLIP PER TRACK (owner 2026-08-14: "Its 1 audio clip per track, so red
 * cant play pre/post at the same time"). A zone plays one clip — a second
 * play request on it doesn't mix, it SUPERSEDES what's sounding, cutting the
 * announcement off mid-sentence. So a press refuses while ITS OWN zone is
 * playing; red and blue run independently. Mega conflicts with both, in both
 * directions, because the mega zone IS the two pits' speakers together.
 * Read from Pandora's websocket cache (instant); an unreadable feed fails
 * OPEN — a blind guard that refused every press on a Pandora blip would be
 * worse than the rare supersede it exists to stop.
 */
function zonesConflict(a: string, b: string): boolean {
  return a === b || a === "mega" || b === "mega";
}

async function paBusy(track: TrackKey): Promise<{ busy: false } | { busy: true; error: string }> {
  const live = await readQsysLive();
  const sounding = live?.zones.find((z) => z.playing && zonesConflict(z.zone, track));
  if (!sounding) return { busy: false };
  const left = sounding.timing?.remainingText ? ` — ${sounding.timing.remainingText} left` : "";
  return {
    busy: true,
    error: `the PA is already playing on ${sounding.zone}${left}; one clip at a time per track`,
  };
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
  /**
   * THE STAGED GROUP, SEATS OR KARTS. Reading `holding` alone was right when the
   * lane had two slots — but this press is now what MOVES a group out of holding
   * and into the karts (see below), so a second press would have found empty
   * seats and refused with "no group is in holding" about a group standing right
   * there. Same `holding ?? karts` rule the rest of the lane uses.
   */
  const staged = lane.holding ?? lane.karts;
  if (!staged) {
    return { ok: false, error: "no group is in holding — pre-race arms when a group is seated" };
  }
  const busy = await paBusy(track);
  if (busy.busy) return { ok: false, error: busy.error };

  const result = await claimAndPlay(track, "pre", staged.sessionId);
  if (result.outcome === "failed") return { ok: false, error: result.error };
  if (result.outcome === "already") {
    return {
      ok: true,
      alreadyPlayed: true,
      atMs: result.atMs ?? undefined,
      sessionId: staged.sessionId,
    };
  }

  const room =
    staged.room ?? (await sessionBriefed(staged.sessionId).catch(() => null))?.room ?? null;
  if (room) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track,
      sessionId: staged.sessionId,
      heatNumber: staged.heatNumber,
      raceType: staged.raceType,
      tier: null,
      action: "audio-pre",
    });
  }

  /**
   * THIS PRESS IS THE "IN KARTS" TRIGGER (owner 2026-08-14: "pit board has a
   * button called play pre. That is what triggers holding to move to karts").
   *
   * The pre-race announcement is what sends a seated group to their karts, so
   * the moment it sounds is the moment the SEATS ARE FREE for the next group —
   * and that is the whole reason the stage exists. Deriving it from this press
   * rather than adding a second one is the same reasoning that put the lane's
   * release on the post-race cue: a press that makes a noise is a press staff
   * actually make, where a press that only updates a screen is one they forget
   * (7 "send to holding" presses across 131 room occupancies, measured
   * 2026-08-13).
   *
   * AFTER the Neon row and after the PA, never before: the row is the durable
   * record and the cue is the thing staff are waiting on, so neither waits on a
   * lane write. markInKarts swallows its own failures and is idempotent, so a
   * Redis blip here costs a board update and never the announcement.
   */
  await markInKarts({
    track,
    sessionId: staged.sessionId,
    heatNumber: staged.heatNumber,
    raceType: staged.raceType,
    room: staged.room,
    atMs: result.atMs,
  }).catch(() => {});

  return { ok: true, atMs: result.atMs, sessionId: staged.sessionId };
}

/**
 * MAY POST-RACE PLAY YET? The announcement calls the finished race back in to
 * hand kit into the room they were briefed in — so that room must be EMPTY
 * (owner 2026-08-14: "post-race is only possible if the briefing room is
 * empty"; same rule the wall's RoomStrip states: a race can only return to a
 * room nobody is briefing in). When the record has lost WHICH room was
 * theirs, they return to whichever is open, so one of the two must be.
 *
 * Exported so the board GET can ship the same verdict the press will get —
 * a button that looks armed but refuses on press is a button staff stop
 * trusting. `short` is the button's compact label; `reason` the full refusal.
 */
export interface PostRaceGate {
  allowed: boolean;
  reason: string | null;
  short: string | null;
}

export async function postRaceGate(sessionId: string): Promise<PostRaceGate> {
  const [briefed, rooms] = await Promise.all([
    sessionBriefed(sessionId).catch(() => null),
    readBriefingRooms(VENUE).catch(() => ({ red: null, blue: null }) as const),
  ]);
  const room = briefed?.room ?? null;
  if (room) {
    const occupant = rooms[room];
    if (occupant) {
      return {
        allowed: false,
        reason: `the ${room} room is still briefing${
          occupant.heatNumber != null ? ` Session ${occupant.heatNumber}` : ""
        } — post-race calls the race back into it, so it must be empty first`,
        short: `${room} room busy`,
      };
    }
    return { allowed: true, reason: null, short: null };
  }
  if (rooms.red && rooms.blue) {
    return {
      allowed: false,
      reason:
        "both briefing rooms are busy — post-race calls the race back in, so a room must be empty first",
      short: "rooms busy",
    };
  }
  return { allowed: true, reason: null, short: null };
}

/**
 * Play the POST-RACE cue for the finished race — and release the lane.
 *
 * Refuses while the race is still out: post arms at the finish marker, and a
 * stamp written early would lock the one play this cycle gets. Only a play
 * that actually SOUNDED writes the pitted stamp (markRacePitted) — that is
 * what flips the wall boards from HOLD back to seating, and an unheard
 * announcement must not reopen the lane. A repeat press RE-ASSERTS the
 * release without replaying: the cue claim is keyed to the resolved racing
 * session, so "already" can only ever be the same cycle pressed twice — a
 * new race finishing in between resolves to a new session and takes a fresh
 * claim instead. Re-stamping pitted therefore cannot mask a new hold, and it
 * is the recovery when a finish marker lands AFTER the first press (a
 * bridge-reconnect replay writing a fresh receive-time) and re-outranks the
 * released hold: press post again and the lane clears.
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
  const gate = await postRaceGate(racing.sessionId);
  if (!gate.allowed) {
    return { ok: false, error: gate.reason ?? "the briefing room is not empty yet" };
  }
  const busy = await paBusy(track);
  if (busy.busy) return { ok: false, error: busy.error };

  const result = await claimAndPlay(track, "post", racing.sessionId);
  if (result.outcome === "failed") return { ok: false, error: result.error };
  if (result.outcome === "already") {
    // Same cycle, pressed again — re-assert the release (see the header for
    // why this is safe): if a straggling finish marker re-raised the hold
    // after the first press, this press is how staff clear it.
    await markRacePitted(track);
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
