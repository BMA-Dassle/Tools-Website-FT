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
 *   pre    a group is STAGED — in the seats or already in the karts
 *   post   a group is in PIT IN: their race is over and they are back in the
 *          lane. The slot existing IS the arming condition (2026-08-15); it
 *          used to demand a finish marker off the racing slot, which left a
 *          demonstrably-returned group unplayable whenever the bridge was quiet
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
import { sessionRoster } from "../service/checkin-progress";
import { cueKey, readCueStamp, type PitCue } from "./audio-stamps.server";
import { markInKarts, markRacePitted, readPitLane } from "./lane.server";
import type { PitLaneFeed, PitLanes } from "./pit-board";
import {
  playQsysCue,
  readQsysLive,
  stopQsysZone,
  STAY_SEATED_FILE,
  type QsysClip,
} from "./qsys.server";

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

/** The biggest grid the NORMAL pre-race clip covers — more than this plays
 *  `big`, the version with the extra warnings ("more than 7 people"). */
const BIG_RACE_MAX_NORMAL = 7;

/**
 * THE CLIPS' KNOWN LENGTHS, measured by the player itself: every successful
 * /play reply carries the clip duration, so the last play of each clip IS the
 * measurement — nothing to configure, nothing to drift when a file is
 * re-recorded. The station uses these to start blinking the pre button one
 * clip-length before the on-track race ends (owner 2026-08-15: "we know how
 * long pre/big is so we should indicate a race almost being done"). Refreshed
 * on every play; 30 days so a clip played any night this month is known
 * tonight. Null until a clip's first ever play — the client falls back to a
 * conservative guess.
 */
function clipLengthKey(clip: QsysClip): string {
  return `pit:audio:cliplen:${clip}`;
}
const CLIP_LEN_TTL_SECONDS = 30 * 24 * 3600;

/**
 * "A birthday is starting or sounding on this track" — the stay-seated loop's
 * only way to know, since the birthday press keeps no stamp (playBirthday
 * explains why). Declared up here with the other key helpers because
 * maybePlayStaySeated, further down, reads it.
 */
function birthdaySoundingKey(track: TrackKey): string {
  return `pit:audio:birthday:${track}`;
}
/** Held only until the player reports the real length — long enough to cover
 *  a clip nobody has measured, short enough to be self-clearing. */
const BIRTHDAY_GUARD_MAX_S = 45;
const BIRTHDAY_GUARD_SLACK_S = 5;

export interface ClipLengths {
  pre: number | null;
  post: number | null;
  big: number | null;
}

export async function readClipLengths(): Promise<ClipLengths> {
  const num = (raw: string | null) => {
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  try {
    const [pre, post, big] = await redis.mget(
      clipLengthKey("pre"),
      clipLengthKey("post"),
      clipLengthKey("big"),
    );
    return { pre: num(pre), post: num(post), big: num(big) };
  } catch {
    return { pre: null, post: null, big: null };
  }
}

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

async function paBusy(
  track: TrackKey,
): Promise<{ busy: false } | { busy: true; error: string; zone: string; file: string }> {
  const live = await readQsysLive();
  const sounding = live?.zones.find((z) => z.playing && zonesConflict(z.zone, track));
  if (!sounding) return { busy: false };
  const left = sounding.timing?.remainingText ? ` — ${sounding.timing.remainingText} left` : "";
  return {
    busy: true,
    error: `the PA is already playing on ${sounding.zone}${left}; one clip at a time per track`,
    zone: sounding.zone,
    file: sounding.file ?? "",
  };
}

/** Is the sounding file the ambient stay-seated loop? Lenient on purpose —
 *  the player may report the file with a path or case of its own. */
function soundingStaySeated(file: string): boolean {
  return file.toLowerCase().includes(STAY_SEATED_FILE.replace(/\.mp3$/i, "").toLowerCase());
}

/**
 * A REAL ANNOUNCEMENT NEVER QUEUES BEHIND THE AMBIENT LOOP (owner 2026-08-15:
 * "pre/post should be able to override it instantly"). When the busy verdict
 * is the stay-seated clip, stop that zone and report clear; any other clip
 * keeps its refusal — cutting off a half-played pre with a post would be the
 * supersede bug the busy guard exists to stop.
 */
async function yieldStaySeated(
  busy: Awaited<ReturnType<typeof paBusy>>,
): Promise<{ cleared: boolean; error?: string }> {
  if (!busy.busy) return { cleared: true };
  if (!soundingStaySeated(busy.file)) return { cleared: false, error: busy.error };
  const stopped = await stopQsysZone(busy.zone);
  return stopped.ok ? { cleared: true } : { cleared: false, error: stopped.error };
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
 *
 * `clip` is WHICH FILE sounds; `cue` is which one-shot it spends. They differ
 * only for the big-race pre (clip `big`, cue `pre`): whichever version plays,
 * it is the same one announcement per cycle, and everything reading the stamp
 * (the wall's pre pill, the station's button, markInKarts) cares that the
 * pre-race played, not which length of it.
 */
async function claimAndPlay(
  track: TrackKey,
  cue: PitCue,
  sessionId: string,
  clip: QsysClip = cue,
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

  const play = await playQsysCue(track, clip);
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
    // The measurement ride-along — see readClipLengths.
    await redis
      .set(clipLengthKey(clip), String(play.durationS), "EX", CLIP_LEN_TTL_SECONDS)
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
  /**
   * A GROUP THAT WENT OUT WITHOUT ITS PRE STILL OWES IT (owner 2026-08-15:
   * "it is not optional and must be played… when they phase one start it moves
   * the session to on track but we STILL owe a pre-race").
   *
   * The lane promotes on the green flag whether or not the cue ever sounded,
   * so reading only the staged slots made an unplayed pre UNPLAYABLE the
   * moment the race started. When nothing is staged and the racing group has
   * no pre stamp, they are the subject: the announcement plays late rather
   * than never, and the insurance row still lands. A staged group always
   * wins — once the next group is seated, the PA belongs to their cycle. The
   * debt ends at the pit: a race that has already come in gets its post, not
   * a pre after the fact.
   */
  let subject = staged ?? null;
  let lateForRacing = false;
  if (!subject && lane.racing) {
    const played = await readCueStamp("pre", lane.racing.sessionId);
    if (!played) {
      subject = {
        sessionId: lane.racing.sessionId,
        heatNumber: lane.racing.heatNumber,
        raceType: null,
        room: null,
        atMs: 0,
      };
      lateForRacing = true;
    }
  }
  if (!subject) {
    return { ok: false, error: "no group is in holding — pre-race arms when a group is seated" };
  }
  // The ambient stay-seated loop yields to this press instantly; anything
  // else sounding keeps its refusal.
  const cleared = await yieldStaySeated(await paBusy(track));
  if (!cleared.cleared) return { ok: false, error: cleared.error ?? "the PA is busy" };

  /**
   * WHICH PRE-RACE CLIP (owner 2026-08-15: "we have technically 2 versions
   * pre and big. They are the same but Big race has some extra warnings. If
   * there are more than 7 people in a race we play big instead of normal pre").
   *
   * Counted off the session's FULL roster, not the checked-in count, and
   * deliberately: the extra warnings are safety copy, so the failure to prefer
   * is playing the longer clip to a group that shrank, never the short clip to
   * a big grid — and a straggler still being walked to a kart is exactly who
   * they are for. An unreadable roster plays the normal pre: the announcement
   * itself must never be held up by a Pandora blip.
   */
  const roster = await sessionRoster(subject.sessionId, Date.now()).catch(() => null);
  const clip: QsysClip = (roster?.length ?? 0) > BIG_RACE_MAX_NORMAL ? "big" : "pre";

  const result = await claimAndPlay(track, "pre", subject.sessionId, clip);
  if (result.outcome === "failed") return { ok: false, error: result.error };
  if (result.outcome === "already") {
    return {
      ok: true,
      alreadyPlayed: true,
      atMs: result.atMs ?? undefined,
      sessionId: subject.sessionId,
    };
  }

  const room =
    subject.room ?? (await sessionBriefed(subject.sessionId).catch(() => null))?.room ?? null;
  if (room) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track,
      sessionId: subject.sessionId,
      heatNumber: subject.heatNumber,
      raceType: subject.raceType,
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
   *
   * NOT for a late pre played to a group already racing — they left the karts
   * long ago, and markInKarts would (rightly) refuse a session in `racing`.
   */
  if (!lateForRacing) {
    await markInKarts({
      track,
      sessionId: subject.sessionId,
      heatNumber: subject.heatNumber,
      raceType: subject.raceType,
      room: subject.room,
      atMs: result.atMs,
    }).catch(() => {});
  }

  return { ok: true, atMs: result.atMs, sessionId: subject.sessionId };
}

/* ── the stay-seated loop ─────────────────────────────────────────────── */

/**
 * "STAY SEATED", ON REPEAT, WHILE KARTS ARE ROLLING IN (owner 2026-08-15:
 * "play a Stay Seated.mp3 when karts are returning to pit… loop it every so
 * often UNTIL a pre/post starts playing").
 *
 * THE ONE AUTOMATIC SOUND ON THE PA, and deliberately a nag rather than a
 * one-shot: the window it covers is exactly when finished racers start
 * climbing out of moving karts' way — the reason the HOLD exists. The clip is
 * ~5s; one play every STAY_SEATED_EVERY_S (owner's spacing requirement:
 * "some time between each repeat") leaves clear air between repeats.
 *
 * DRIVEN BY POLLS, THROTTLED BY REDIS. Nothing here schedules anything: the
 * pulse (every wall, 2s) and the pit station's own poll both nudge it, and an
 * NX claim with the interval as its TTL means one play per interval per track
 * however many screens ask. A quiet building with no screens on plays
 * nothing, which is the right failure.
 *
 * WHEN IT PLAYS — every condition read off the resolved lane:
 *   • a group is in `pitIn` (karts in or rolling in, post owed) — the loop's
 *     whole subject;
 *   • their post is not ALREADY sounding (postRaceAtMs set = pitIn surviving
 *     the clip, see clearAnsweredPitIn);
 *   • the pit has not been sitting for over STAY_SEATED_MAX_MS — a stale,
 *     forgotten slot must not nag an empty building all night;
 *   • the PA is idle on every conflicting zone (a pre for the next group,
 *     a post, mega vs its pits — the loop never talks over anything).
 *
 * It stops the moment pre/post claims the zone two ways: the busy check here
 * skips the interval, and the press itself /stops a mid-play loop clip
 * (yieldStaySeated). No stamp, no Neon row — ambient safety audio is not a
 * cycle event; the play itself is still console-logged by playQsysCue.
 */
/** The SILENCE between repeats (owner 2026-08-15: "the gap between each needs
 *  to be 15s"). The throttle spaces play STARTS, so the claim TTL is this gap
 *  plus the clip's own ~5s. */
const STAY_SEATED_GAP_S = 15;
const STAY_SEATED_CLIP_S = 5;
const STAY_SEATED_EVERY_S = STAY_SEATED_GAP_S + STAY_SEATED_CLIP_S;
const STAY_SEATED_MAX_MS = 15 * 60_000;

async function maybePlayStaySeated(track: TrackKey, lane: PitLaneFeed): Promise<void> {
  const pitIn = lane.pitIn;
  if (!pitIn) return;
  if (pitIn.postRaceAtMs != null) return;
  if (Date.now() - pitIn.atMs > STAY_SEATED_MAX_MS) return;
  // The claim FIRST, the Pandora read after: polls arrive every 2 seconds and
  // the live read must happen once per interval, not once per poll. A busy PA
  // burns the interval — better a repeat 25s late than talked-over audio.
  const claimed = await redis
    .set(`pit:audio:stay-seated:${track}`, "1", "EX", STAY_SEATED_EVERY_S, "NX")
    .catch(() => null);
  if (claimed !== "OK") return;
  const busy = await paBusy(track);
  if (busy.busy) return;
  /**
   * THE CLAIM-TO-SOUND WINDOW. A pre/post press writes its stamp BEFORE the
   * player answers (~a second), so a stamp the zone does not sound yet means
   * an announcement is starting RIGHT NOW — and a loop play landing after it
   * would supersede it (one clip per zone). Post is checked by existence, not
   * age: POST ENDS THE LOOP, full stop (owner 2026-08-15: "It should not
   * resume playing if post completes") — belt to the lane's braces, for reads
   * that catch the lane mid-update. Pre only guards its own sounding window,
   * because the loop legitimately resumes after a pre if post is still owed.
   */
  const staged = lane.holding ?? lane.karts;
  const [post, pre] = await Promise.all([
    readCueStamp("post", pitIn.sessionId),
    staged ? readCueStamp("pre", staged.sessionId) : Promise.resolve(null),
  ]);
  if (post) return;
  if (pre && Date.now() - pre.atMs < ((pre.durationS ?? 60) + 10) * 1000) return;
  /**
   * THE BIRTHDAY HAS NO STAMP TO CHECK — it is repeatable by design, so the
   * guard above has nothing to read for it. Its press leaves this marker
   * instead, for exactly the window the comment above describes: the loop must
   * not supersede a birthday that is starting or sounding. A marker, not a
   * claim — it never gates a press, only this loop.
   */
  if (await redis.exists(birthdaySoundingKey(track)).catch(() => 0)) return;
  await playQsysCue(track, "stay-seated");
}

/** The poll-side nudge — every lane, one call. Swallows everything: this
 *  rides display polls, and a PA blip must never cost a feed response. */
export async function nudgeStaySeated(lanes: PitLanes): Promise<void> {
  const tracks: TrackKey[] = ["blue", "red", "mega"];
  await Promise.all(tracks.map((t) => maybePlayStaySeated(t, lanes[t]).catch(() => {})));
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
  /**
   * POST-RACE IS FOR THE GROUP IN THE PIT (2026-08-15).
   *
   * It used to read `racing` and then demand a finish stamp off it — two reads
   * of one slot that had to mean two different things at two different times.
   * That gate is what left blue 62 unplayable on a night the finish marker never
   * landed: the group was demonstrably back, and the only control that could say
   * so refused because nothing on the wire had agreed yet.
   *
   * The `pitIn` slot IS "a race has come in and owes its announcement", so
   * occupying it is the whole arming condition. A group still genuinely on track
   * is in `racing` and cannot be posted, which was the point of the old gate.
   */
  const returning = lane.pitIn;
  if (!returning) {
    return {
      ok: false,
      error: "no race is back in the pit — post-race arms when a race comes in",
    };
  }
  const gate = await postRaceGate(returning.sessionId);
  if (!gate.allowed) {
    return { ok: false, error: gate.reason ?? "the briefing room is not empty yet" };
  }
  // Same yield rule as pre: the stay-seated loop stops for the announcement
  // that answers it, and only for that.
  const cleared = await yieldStaySeated(await paBusy(track));
  if (!cleared.cleared) return { ok: false, error: cleared.error ?? "the PA is busy" };

  const result = await claimAndPlay(track, "post", returning.sessionId);
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
      sessionId: returning.sessionId,
    };
  }

  const room = (await sessionBriefed(returning.sessionId).catch(() => null))?.room ?? null;
  if (room) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track,
      sessionId: returning.sessionId,
      heatNumber: returning.heatNumber,
      raceType: null,
      tier: null,
      action: "audio-post",
    });
  }

  // The release. markRacePitted resolves the racing group itself and writes
  // its own insurance row — one code path for this stamp, whoever presses.
  await markRacePitted(track);

  return { ok: true, atMs: result.atMs, sessionId: returning.sessionId };
}

/* ── the birthday cue ─────────────────────────────────────────────────── */

/**
 * "Happy birthday" on one track's zone (owner 2026-08-15).
 *
 * DELIBERATELY NOT A ONE-SHOT, unlike pre and post. Those two are steps in a
 * turnover: each belongs to exactly one session, and firing twice either cuts
 * an announcement in half or burns the cycle's only play. This one belongs to
 * a PERSON, not a cycle — several birthday groups pass through a track in a
 * night, and a group that missed it wants it again. So there is no NX claim,
 * no stamp, no arming condition and no Neon row: it is a courtesy sound staff
 * press when they mean to, and pressing it twice is a legitimate thing to
 * want. (The play itself is still console-logged by playQsysCue, same as the
 * ambient loop.)
 *
 * IT DOES NOT GET THE PRE/POST OVERRIDE. `yieldStaySeated` exists because a
 * real announcement must never queue behind ambient audio — but the loop is
 * SAFETY copy playing while karts roll into the pit, and that is precisely
 * the wrong moment to talk over it with happy birthday. So this press takes
 * the plain busy guard: it waits its turn behind everything, including the
 * loop, and the button says which zone is holding it. Staff press it after
 * the post-race, which is when the group is out of the karts to hear it
 * anyway.
 */
export async function playBirthday(track: TrackKey): Promise<PlayCueResult> {
  const busy = await paBusy(track);
  if (busy.busy) return { ok: false, error: busy.error };

  /**
   * SET BEFORE THE PLAY, because the window it covers OPENS before the player
   * answers — the same claim-to-sound race maybePlayStaySeated guards pre and
   * post against by their stamps. A conservative TTL first, narrowed to the
   * real clip length once the player reports it, and dropped when the play
   * never happened. Every write is best-effort: a Redis blip must cost the
   * loop's manners, never the announcement.
   */
  const marker = birthdaySoundingKey(track);
  await redis.set(marker, "1", "EX", BIRTHDAY_GUARD_MAX_S).catch(() => void 0);

  const play = await playQsysCue(track, "birthday");
  if (!play.ok) {
    await redis.del(marker).catch(() => void 0);
    return { ok: false, error: play.error ?? "the PA did not start the birthday clip" };
  }
  if (play.durationS != null) {
    await redis
      .set(marker, "1", "EX", Math.ceil(play.durationS) + BIRTHDAY_GUARD_SLACK_S)
      .catch(() => void 0);
  }
  return { ok: true, atMs: Date.now() };
}
