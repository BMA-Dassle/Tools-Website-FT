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
import type { BriefingRoom, BriefingRoomState } from "../briefing/types";
import type { TrackKey } from "../track";
import { sessionRoster } from "../service/checkin-progress";
import { cueKey, readCueStamp, type PitCue } from "./audio-stamps.server";
import { postClipCandidates } from "./post-clip";
import { preClipFor, preClipNeedsRoster } from "./pre-clip";
import { markInKarts, markRacePitted, readPitLane } from "./lane.server";
import { isStaySeatedFile, kartsAvailability, type PitLaneFeed, type PitLanes } from "./pit-board";
import {
  playQsysCue,
  stopQsysZone,
  STAY_SEATED_FILE,
  type QsysClip,
  type QsysLiveState,
} from "./qsys.server";
import { readQsysTruth } from "./qsys-truth.server";
import {
  CUE_SYNC_RESULT_WAIT_MS,
  CUE_SYNC_WINDOW_MS,
  syncPartner,
  syncedZoneFor,
} from "./cue-sync";
import {
  announceSyncIntent,
  claimSyncLead,
  clearSyncIntents,
  publishSyncResult,
  releaseSyncLead,
  waitForSyncIntent,
  waitForSyncResult,
} from "./cue-sync.server";

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
 * Read from Pandora's websocket cache, CROSS-CHECKED against the Core
 * (qsys-truth.server.ts — the cache froze with mega "playing" for an hour on
 * 2026-09-10 and locked every control); an unreadable feed fails OPEN — a
 * blind guard that refused every press on a Pandora blip would be worse than
 * the rare supersede it exists to stop.
 */
function zonesConflict(a: string, b: string): boolean {
  return a === b || a === "mega" || b === "mega";
}

type PaBusyVerdict = { busy: false } | { busy: true; error: string; zone: string; file: string };

/** The pure half — verdict from a live state already in hand, so the shared
 *  stay-seated beat can check every zone off ONE Pandora read. */
function paBusyIn(track: TrackKey, live: QsysLiveState | null): PaBusyVerdict {
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

async function paBusy(track: TrackKey): Promise<PaBusyVerdict> {
  // `fresh`: a press must not read a 2s-old beat — a post landing a second
  // after a pre started would see an idle zone and supersede it.
  return paBusyIn(track, await readQsysTruth({ fresh: true }));
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
  if (!isStaySeatedFile(busy.file)) return { cleared: false, error: busy.error };
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
  /** Both pits pressed inside the sync window and ONE announcement went out
   *  on the mega zone for both groups (cue-sync.ts, owner 2026-09-10). */
  synced?: boolean;
  /** Which zone actually sounded — the track's own, or `mega` when synced. */
  zone?: string;
}

/* ── the one-shot claim ────────────────────────────────────────────────── */

type CueClaim =
  | { claimed: true; key: string; atMs: number }
  | { claimed: false; atMs: number | null };

/**
 * Claim the one-shot BEFORE the play request goes out — two tablets pressing
 * together race for one claim, and only the winner talks to the PA. A loser
 * reports the existing stamp so the press can say "already played at 7:36".
 */
async function claimCue(cue: PitCue, sessionId: string): Promise<CueClaim> {
  const atMs = Date.now();
  const key = cueKey(cue, sessionId);
  const claimed = await redis
    .set(key, JSON.stringify({ atMs, durationS: null }), "EX", STAMP_TTL_SECONDS, "NX")
    .catch(() => null);
  if (claimed === "OK") return { claimed: true, key, atMs };
  const stamp = await readCueStamp(cue, sessionId);
  return { claimed: false, atMs: stamp?.atMs ?? null };
}

/** A play that FAILED releases its claims, so the buttons re-arm and the
 *  press can retry. A DEL that itself fails leaves a stamp the TTL clears. */
async function releaseClaims(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => redis.del(k).catch(() => void 0)));
}

/**
 * A play that SOUNDED rewrites its claims with the clip duration the player
 * reported — a plain overwrite, safe because the claims are already ours —
 * and records the measurement (see readClipLengths). Nothing to write when
 * the player did not say.
 */
async function settleClaims(
  keys: string[],
  atMs: number,
  durationS: number | null,
  clip: QsysClip,
): Promise<void> {
  if (durationS == null) return;
  await Promise.all([
    ...keys.map((k) =>
      redis
        .set(k, JSON.stringify({ atMs, durationS }), "EX", STAMP_TTL_SECONDS)
        .catch(() => void 0),
    ),
    redis
      .set(clipLengthKey(clip), String(durationS), "EX", CLIP_LEN_TTL_SECONDS)
      .catch(() => void 0),
  ]);
}

/**
 * Claim the one-shot, fire the PA on the track's own zone, and settle the
 * stamp — the SOLO play. Claim-first so concurrent presses can't both reach
 * the player; on a failed play the claim is released so the next press
 * retries.
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
  const claim = await claimCue(cue, sessionId);
  if (!claim.claimed) return { outcome: "already", atMs: claim.atMs };

  const play = await playQsysCue(track, clip);
  if (!play.ok) {
    await releaseClaims([claim.key]);
    return { outcome: "failed", error: play.error ?? "the PA did not start the cue" };
  }
  await settleClaims([claim.key], claim.atMs, play.durationS, clip);
  return { outcome: "played", atMs: claim.atMs };
}

/* ── who each cue plays for ────────────────────────────────────────────── */

/** The group a cue is for — the lane slot's identity fields, nothing more. */
interface CueSubject {
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  room: BriefingRoom | null;
  atMs: number;
}

type PreSubjectVerdict =
  | { ok: true; subject: CueSubject; lateForRacing: boolean }
  | { ok: false; error: string };

/**
 * WHO THE PRE-RACE CUE PLAYS FOR on a lane, and whether it may play at all.
 * Pulled out of playPreRace (2026-09-10) so the sync path can ask the SAME
 * question of the other track before deciding to wait for it — every rule
 * here is playPreRace's own, moved not changed, and the incidents that bought
 * each one stay beside it.
 */
async function resolvePreSubject(lane: PitLaneFeed): Promise<PreSubjectVerdict> {
  /**
   * THE FURTHEST-ALONG GROUP, KARTS FIRST (owner 2026-08-16: "the pit
   * controller should be showing race that's in the rail").
   *
   * This read `holding ?? karts`, while the wall's rail names `karts ??
   * holding` — so once somebody was strapped in, the station card and the wall
   * described different groups, and the press would have played for whichever
   * one the card was NOT showing. One rule, two surfaces: they now agree.
   *
   * It is also the right order on its own terms. A group in the karts is closer
   * to the flag than one in the seats, so if both somehow owe a cue, theirs is
   * the urgent one. The two orderings only differ while the karts are occupied,
   * and in that window the seated group's cue cannot play anyway — the karts
   * are not free for them to walk into.
   */
  const staged = lane.karts ?? lane.holding;
  /**
   * A GROUP THAT WENT OUT WITHOUT ITS PRE STILL OWES IT (owner 2026-08-15:
   * "it is not optional and must be played… when they phase one start it moves
   * the session to on track but we STILL owe a pre-race").
   *
   * The lane promotes on the green flag whether or not the cue ever sounded,
   * so reading only the staged slots made an unplayed pre UNPLAYABLE the
   * moment the race started. The debt ends at the pit: a race that has already
   * come in gets its post, not a pre after the fact.
   *
   * THE DEBT OUTRANKS THE NEXT CYCLE (owner 2026-08-16). This used to be tried
   * only when NOTHING was staged — "a staged group always wins, once the next
   * group is seated the PA belongs to their cycle" — which meant seating the
   * next group did not delay an owed announcement, it DESTROYED it. Nothing
   * could reach that group again.
   *
   * It happened within minutes of the banner shipping. Blue 20 went green at
   * 3:05:38 with no pre; the STOP SENDING wall told staff to play it; they
   * pressed at 3:09:36 and the cue paid blue 21's cycle instead, because 21 was
   * already seated. 20's stamp had to be written by hand for the wall to clear.
   * A banner that instructs a press nobody can perform is worse than no banner.
   *
   * So an outstanding debt is checked FIRST. The seated group's cue waits one
   * press, which costs them seconds; the racing group's cue is otherwise gone
   * for good. That is the owner's own rule about this cue — "it is not optional
   * and must be played".
   */
  let subject: CueSubject | null = null;
  let lateForRacing = false;
  if (lane.racing) {
    const played = await readCueStamp("pre", lane.racing.sessionId);
    if (!played) {
      subject = {
        sessionId: lane.racing.sessionId,
        heatNumber: lane.racing.heatNumber,
        raceType: lane.racing.raceType,
        room: null,
        atMs: 0,
      };
      lateForRacing = true;
    }
  }
  if (!subject && staged) {
    subject = {
      sessionId: staged.sessionId,
      heatNumber: staged.heatNumber,
      raceType: staged.raceType,
      room: staged.room,
      atMs: staged.atMs,
    };
  }
  if (!subject) {
    return { ok: false, error: "no group is in holding — pre-race arms when a group is seated" };
  }
  /**
   * NOT WHILE SOMEBODY ELSE IS IN THE KARTS (owner 2026-08-16, live: blue 17 in
   * the seats with blue 16 strapped in waiting on the green).
   *
   * This cue is what walks the seated group into their karts, so it cannot be
   * owed while the karts are full. Playing it would call 17 to a lane that is
   * not free — and markInKarts, which this press triggers, would overwrite 16
   * off the board entirely.
   *
   * Refused here as well as in markInKarts because the announcement itself is
   * the harm: stopping the lane write alone would still have put the wrong
   * instruction over the PA.
   */
  if (!lateForRacing) {
    const verdict = kartsAvailability({ karts: lane.karts, sessionId: subject.sessionId });
    if (!verdict.ok) return { ok: false, error: verdict.error };
  }
  return { ok: true, subject, lateForRacing };
}

type PostSubjectVerdict =
  | { ok: true; returning: NonNullable<PitLaneFeed["pitIn"]>; gate: PostRaceGate }
  | { ok: false; error: string };

/**
 * WHO THE POST-RACE CUE PLAYS FOR on a lane, and whether its room is clear.
 *
 * POST-RACE IS FOR THE GROUP IN THE PIT (2026-08-15). It used to read
 * `racing` and then demand a finish stamp off it — two reads of one slot that
 * had to mean two different things at two different times. That gate is what
 * left blue 62 unplayable on a night the finish marker never landed: the
 * group was demonstrably back, and the only control that could say so refused
 * because nothing on the wire had agreed yet. The `pitIn` slot IS "a race has
 * come in and owes its announcement", so occupying it is the whole arming
 * condition. A group still genuinely on track is in `racing` and cannot be
 * posted, which was the point of the old gate.
 */
async function resolvePostSubject(lane: PitLaneFeed): Promise<PostSubjectVerdict> {
  const returning = lane.pitIn;
  if (!returning) {
    return {
      ok: false,
      error: "no race is back in the pit — post-race arms when a race comes in",
    };
  }
  const gate = await postRaceGate(returning.sessionId);
  return { ok: true, returning, gate };
}

/* ── what a played cue leaves behind ───────────────────────────────────── */

/**
 * The Neon row is the durable record and is written only on a fresh, PLAYED
 * claim — awaited and uncaught, same posture as every briefing event: a
 * staff action whose record cannot land should fail loudly, not proceed
 * unrecorded. The room on the row is the room the group was briefed in.
 */
async function recordPre(track: TrackKey, subject: CueSubject): Promise<void> {
  const room =
    subject.room ?? (await sessionBriefed(subject.sessionId).catch(() => null))?.room ?? null;
  if (!room) return;
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
 * THE LANE MOVE RIDES EVERY SUCCESSFUL PRESS, A REPLAY INCLUDED (2026-09-01).
 * It used to live only under the fresh-play exit — so the SECOND press of
 * Play Pre, which is the one staff make when the board did not move the first
 * time, could never move it either (the cue is a one-shot: every later press
 * returns `already`). That is the trap markInKarts documents from the other
 * side (red 19/20 on 2026-08-16): a group whose cue had sounded but whose slot
 * had not moved was unrecoverable from any button. markInKarts is idempotent
 * by design, so a replay costs a Redis read and changes nothing when there is
 * nothing to change.
 *
 * AFTER the Neon row and after the PA, never before: the row is the durable
 * record and the cue is the thing staff are waiting on, so neither waits on a
 * lane write. markInKarts swallows its own failures.
 *
 * NOT for a late pre played to a group already racing — they left the karts
 * long ago, and markInKarts would (rightly) refuse a session in `racing`.
 */
async function moveIntoKarts(
  track: TrackKey,
  subject: CueSubject,
  lateForRacing: boolean,
  atMs: number | null,
): Promise<void> {
  if (lateForRacing) return;
  await markInKarts({
    track,
    sessionId: subject.sessionId,
    heatNumber: subject.heatNumber,
    raceType: subject.raceType,
    room: subject.room,
    // markInKarts reads an absent stamp as "now", which is the right reading
    // for a claim that came back without one.
    atMs: atMs ?? undefined,
  }).catch(() => {});
}

/** The insurance row for a post that sounded — keeps the MARKER's room, as
 *  it always has. */
async function recordPost(
  track: TrackKey,
  returning: NonNullable<PitLaneFeed["pitIn"]>,
  briefedRoom: BriefingRoom | null,
): Promise<void> {
  if (!briefedRoom) return;
  await recordBriefingEvent({
    venue: VENUE,
    businessDay: businessDayYmdET(),
    room: briefedRoom,
    track,
    sessionId: returning.sessionId,
    heatNumber: returning.heatNumber,
    raceType: null,
    tier: null,
    action: "audio-post",
  });
}

/* ── two pits pressed together ─────────────────────────────────────────── */

/**
 * THE SYNC DECISION for a press that has already passed every arming check
 * on its own track (cue-sync.ts has the rule and the owner's words).
 *
 *   solo     play on your own zone now — no partner, partner not armed, the
 *            window closed with nobody, or Redis could not coordinate
 *   lead     the partner pressed inside the window: play ONCE for both
 *   relayed  the partner was already holding the window and has played for
 *            both — here is what happened to YOUR cue
 *
 * `heldLead` on a solo verdict means this press held the window and nobody
 * came; it publishes its solo outcome so a repeat press of the same button
 * that arrived meanwhile can pick it up instead of waiting out its own clock.
 */
type SyncVerdict =
  | { kind: "solo"; heldLead: boolean }
  | { kind: "lead"; partner: TrackKey; partnerSessionId: string }
  | { kind: "relayed"; result: PlayCueResult };

/**
 * Is the other pit armed for the same cue RIGHT NOW — a subject its own press
 * would resolve, nothing sounded for it yet, and (for post) its room clear?
 * The same resolvers the press itself uses, so "armed" here means "their
 * press would go through", never a guess.
 */
async function partnerArmed(cue: PitCue, partner: TrackKey): Promise<boolean> {
  const lane = await readPitLane(partner).catch(() => null);
  if (!lane) return false;
  if (cue === "pre") {
    const r = await resolvePreSubject(lane);
    if (!r.ok) return false;
    return (await readCueStamp("pre", r.subject.sessionId)) == null;
  }
  const r = await resolvePostSubject(lane);
  if (!r.ok || !r.gate.allowed) return false;
  return (await readCueStamp("post", r.returning.sessionId)) == null;
}

async function syncWithPartner(
  cue: PitCue,
  track: TrackKey,
  sessionId: string,
): Promise<SyncVerdict> {
  const partner = syncPartner(track);
  if (!partner) return { kind: "solo", heldLead: false };
  if (!(await partnerArmed(cue, partner))) return { kind: "solo", heldLead: false };

  const lead = await claimSyncLead(cue, track);
  if (lead.role === "unavailable") return { kind: "solo", heldLead: false };

  if (lead.role === "lead") {
    await announceSyncIntent(cue, track, sessionId);
    const joined = await waitForSyncIntent(cue, partner, CUE_SYNC_WINDOW_MS);
    if (joined) return { kind: "lead", partner, partnerSessionId: joined.sessionId };
    // Nobody came. Hand the window back before playing solo, so the partner's
    // next press is a fresh decision rather than a follower of a ghost.
    await clearSyncIntents(cue, [track]);
    await releaseSyncLead(cue);
    return { kind: "solo", heldLead: true };
  }

  // Somebody holds the window. If it is the other pit, this press is exactly
  // what they are waiting for — announce and let them play for both. If it is
  // THIS track (the same button pressed twice while the first press holds),
  // just wait for that press's outcome; it will be ours too.
  if (lead.leader !== track) await announceSyncIntent(cue, track, sessionId);
  const relayed = await waitForSyncResult(cue, track, sessionId, CUE_SYNC_RESULT_WAIT_MS);
  if (relayed) return { kind: "relayed", result: relayed };
  // The leader vanished (instance killed mid-window). Play for yourself.
  return { kind: "solo", heldLead: false };
}

/** The leader's exit: tell both presses what happened, give the window back. */
async function settleSync(
  cue: PitCue,
  mine: { track: TrackKey; sessionId: string; result: PlayCueResult },
  partner: { track: TrackKey; sessionId: string; result: PlayCueResult } | null,
): Promise<PlayCueResult> {
  await Promise.all([
    publishSyncResult(cue, mine.track, { ...mine.result, sessionId: mine.sessionId }),
    partner
      ? publishSyncResult(cue, partner.track, { ...partner.result, sessionId: partner.sessionId })
      : Promise.resolve(),
  ]);
  await clearSyncIntents(cue, partner ? [mine.track, partner.track] : [mine.track]);
  await releaseSyncLead(cue);
  return mine.result;
}

/* ── the PRE-RACE cue ──────────────────────────────────────────────────── */

/** The solo pre: this track's zone, this track's clip, this group's records. */
async function playPreOn(
  track: TrackKey,
  resolved: { subject: CueSubject; lateForRacing: boolean },
): Promise<PlayCueResult> {
  const { subject, lateForRacing } = resolved;
  /**
   * WHICH PRE-RACE CLIP — the rule, the Mega exemption and the incident that
   * bought it all live in pre-clip.ts. Mega skips the roster read entirely:
   * it plays the normal pre at every grid size, so the answer could not
   * change the clip.
   */
  const roster = preClipNeedsRoster(track)
    ? await sessionRoster(subject.sessionId, Date.now()).catch(() => null)
    : null;
  const clip: QsysClip = preClipFor(track, roster?.length ?? null);

  const result = await claimAndPlay(track, "pre", subject.sessionId, clip);
  if (result.outcome === "failed") return { ok: false, error: result.error };

  if (result.outcome === "already") {
    await moveIntoKarts(track, subject, lateForRacing, result.atMs);
    return {
      ok: true,
      alreadyPlayed: true,
      atMs: result.atMs ?? undefined,
      sessionId: subject.sessionId,
      zone: track,
    };
  }

  await recordPre(track, subject);
  await moveIntoKarts(track, subject, lateForRacing, result.atMs);
  return { ok: true, atMs: result.atMs, sessionId: subject.sessionId, zone: track };
}

/**
 * THE SYNCED PRE: both pits pressed inside the window, so ONE announcement on
 * the mega zone — both pits' speakers — and every record, stamp and lane
 * move each group would have had from its own press.
 *
 * The partner's press is re-resolved off its lane HERE, at play time, with
 * the same resolver its own press used: if the lane no longer names the
 * group they pressed for, their press gets that refusal and this track plays
 * solo. The partner's zone yields its stay-seated loop like any press.
 *
 * WHICH CLIP ON MEGA: the normal `pre`, never `big`, for the same reason
 * pre-clip.ts exempts Mega — the Core's mega `big` entry names a file that
 * is not on the drive and "plays" 204ms of nothing (2026-08-18). Two big
 * grids pressed together therefore hear the normal pre; the alternative is
 * two grids hearing nothing.
 */
async function playPreSynced(
  track: TrackKey,
  mine: { subject: CueSubject; lateForRacing: boolean },
  partner: TrackKey,
  partnerSessionId: string,
): Promise<PlayCueResult> {
  const pLane = await readPitLane(partner);
  const pResolved = await resolvePreSubject(pLane);
  const refusePartner = async (error: string): Promise<PlayCueResult> => {
    const solo = await playPreOn(track, mine);
    return settleSync(
      "pre",
      { track, sessionId: mine.subject.sessionId, result: solo },
      { track: partner, sessionId: partnerSessionId, result: { ok: false, error } },
    );
  };
  if (!pResolved.ok) return refusePartner(pResolved.error);
  if (pResolved.subject.sessionId !== partnerSessionId) {
    return refusePartner("the group in holding changed while syncing — press again");
  }
  // BOTH zones must be clear NOW, not just the partner's: the hold gave the
  // stay-seated loop up to five seconds to start on either pit, and zones run
  // independently — a loop left sounding on one pit would play on under the
  // mega announcement. One fresh read, two verdicts (mega, if sounding, names
  // itself in both; stopping it twice is harmless). A REAL clip on this track
  // refuses both presses — the partner's press would have been refused for
  // the same reason on its own.
  const live = await readQsysTruth({ fresh: true });
  const [mineCleared, pCleared] = await Promise.all([
    yieldStaySeated(paBusyIn(track, live)),
    yieldStaySeated(paBusyIn(partner, live)),
  ]);
  if (!mineCleared.cleared) {
    const busy: PlayCueResult = { ok: false, error: mineCleared.error ?? "the PA is busy" };
    return settleSync(
      "pre",
      { track, sessionId: mine.subject.sessionId, result: busy },
      { track: partner, sessionId: partnerSessionId, result: busy },
    );
  }
  if (!pCleared.cleared) return refusePartner(pCleared.error ?? "the PA is busy");

  const sides = [
    { track, subject: mine.subject, lateForRacing: mine.lateForRacing },
    { track: partner, subject: pResolved.subject, lateForRacing: pResolved.lateForRacing },
  ] as const;
  const claims = await Promise.all(sides.map((s) => claimCue("pre", s.subject.sessionId)));
  const claimedTracks = sides.filter((_, i) => claims[i].claimed).map((s) => s.track);
  const zone = syncedZoneFor(claimedTracks);

  const resultFor = (i: number, play: { atMs: number } | null): PlayCueResult => {
    const claim = claims[i];
    if (!claim.claimed) {
      return {
        ok: true,
        alreadyPlayed: true,
        atMs: claim.atMs ?? undefined,
        sessionId: sides[i].subject.sessionId,
        zone: sides[i].track,
      };
    }
    return {
      ok: true,
      atMs: play?.atMs ?? claim.atMs,
      sessionId: sides[i].subject.sessionId,
      synced: zone === "mega",
      zone: zone ?? sides[i].track,
    };
  };

  if (!zone) {
    // Both cues had already sounded — two replays. The lane moves still ride
    // them (see moveIntoKarts), and neither press is an error.
    await Promise.all(
      sides.map((s, i) => moveIntoKarts(s.track, s.subject, s.lateForRacing, claims[i].atMs)),
    );
    return settleSync(
      "pre",
      { track, sessionId: mine.subject.sessionId, result: resultFor(0, null) },
      { track: partner, sessionId: partnerSessionId, result: resultFor(1, null) },
    );
  }

  let clip: QsysClip;
  if (zone === "mega") {
    clip = preClipFor("mega", null);
  } else {
    // One zone means one group's cue already sounded; the other plays its own
    // clip under its own grid-size rule, exactly as a solo press would.
    const side = sides[zone === track ? 0 : 1];
    const roster = await sessionRoster(side.subject.sessionId, Date.now()).catch(() => null);
    clip = preClipFor(zone, roster?.length ?? null);
  }
  const play = await playQsysCue(zone, clip);
  const claimedKeys = claims.flatMap((c) => (c.claimed ? [c.key] : []));
  if (!play.ok) {
    await releaseClaims(claimedKeys);
    const failed: PlayCueResult = {
      ok: false,
      error: play.error ?? "the PA did not start the cue",
    };
    return settleSync(
      "pre",
      { track, sessionId: mine.subject.sessionId, result: failed },
      { track: partner, sessionId: partnerSessionId, result: failed },
    );
  }
  const atMs = Math.min(...claims.flatMap((c) => (c.claimed ? [c.atMs] : [])));
  await settleClaims(claimedKeys, atMs, play.durationS, clip);
  console.log(`[pit] synced pre on ${zone} for ${claimedTracks.join("+")}`);

  for (const [i, s] of sides.entries()) {
    const claim = claims[i];
    if (claim.claimed) await recordPre(s.track, s.subject);
    await moveIntoKarts(s.track, s.subject, s.lateForRacing, claim.claimed ? atMs : claim.atMs);
  }
  return settleSync(
    "pre",
    { track, sessionId: mine.subject.sessionId, result: resultFor(0, { atMs }) },
    { track: partner, sessionId: partnerSessionId, result: resultFor(1, { atMs }) },
  );
}

/**
 * Play the PRE-RACE cue for whatever group is in the track's holding.
 *
 * Resolve who it is for (resolvePreSubject), make sure the zone is clear
 * (the stay-seated loop yields), then either sync with the other pit's press
 * or play on this track's own zone.
 */
export async function playPreRace(track: TrackKey): Promise<PlayCueResult> {
  const lane = await readPitLane(track);
  const resolved = await resolvePreSubject(lane);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // The ambient stay-seated loop yields to this press instantly; anything
  // else sounding keeps its refusal.
  const cleared = await yieldStaySeated(await paBusy(track));
  if (!cleared.cleared) return { ok: false, error: cleared.error ?? "the PA is busy" };

  const sync = await syncWithPartner("pre", track, resolved.subject.sessionId);
  if (sync.kind === "relayed") return sync.result;
  if (sync.kind === "lead") {
    return playPreSynced(track, resolved, sync.partner, sync.partnerSessionId);
  }
  const result = await playPreOn(track, resolved);
  if (sync.heldLead) {
    await publishSyncResult("pre", track, { ...result, sessionId: resolved.subject.sessionId });
  }
  return result;
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
const STAY_SEATED_GAP_S = 5;
const STAY_SEATED_CLIP_S = 5;
const STAY_SEATED_EVERY_S = STAY_SEATED_GAP_S + STAY_SEATED_CLIP_S;
const STAY_SEATED_MAX_MS = 15 * 60_000;

/** Is this lane inside its stay-seated window? The cheap, Redis-free half of
 *  the decision — the shared beat below only spends its claim when at least
 *  one lane says yes. */
function staySeatedWindow(lane: PitLaneFeed): boolean {
  const pitIn = lane.pitIn;
  if (!pitIn) return false;
  if (pitIn.postRaceAtMs != null) return false;
  return Date.now() - pitIn.atMs <= STAY_SEATED_MAX_MS;
}

/**
 * One track's play on the shared beat. The guards are per-track — a pre
 * sounding on red must silence red's repeat without costing blue its beat.
 */
async function playStaySeatedOn(
  track: TrackKey,
  lane: PitLaneFeed,
  live: QsysLiveState | null,
): Promise<void> {
  const pitIn = lane.pitIn;
  if (!pitIn) return;
  const busy = paBusyIn(track, live);
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
  await playQsysCue(track, "stay-seated");
}

/**
 * The poll-side nudge — every lane, one call. Swallows everything: this
 * rides display polls, and a PA blip must never cost a feed response.
 *
 * ONE BEAT FOR THE WHOLE VENUE (owner 2026-08-15: "if both are returning at
 * the same time both stay seated things should play at the same time"). The
 * two pits share a fence, so two per-track timers at arbitrary phase offsets
 * would sound like a clip every few seconds from alternating speakers. The
 * throttle claim is therefore VENUE-scoped: whoever wins it plays every lane
 * currently in its window in the same breath, so simultaneous returns repeat
 * in unison. A lone returning race behaves exactly as before, and a track
 * whose zone is busy this beat (a pre sounding) just sits the beat out —
 * it rejoins the shared rhythm on the next one.
 */
export async function nudgeStaySeated(lanes: PitLanes): Promise<void> {
  const tracks: TrackKey[] = ["blue", "red", "mega"];
  const due = tracks.filter((t) => staySeatedWindow(lanes[t]));
  if (due.length === 0) return;
  // The claim FIRST, the Pandora read after: polls arrive every 2 seconds and
  // the live read must happen once per beat, not once per poll. A busy PA
  // burns the beat — better a repeat 10s late than talked-over audio.
  const claimed = await redis
    .set("pit:audio:stay-seated:FT", "1", "EX", STAY_SEATED_EVERY_S, "NX")
    .catch(() => null);
  if (claimed !== "OK") return;
  // One live read shared by every lane on the beat.
  const live = await readQsysTruth();
  await Promise.all(due.map((t) => playStaySeatedOn(t, lanes[t], live).catch(() => {})));
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
  /**
   * WHICH ROOMS ARE DOING THE BLOCKING — the same refusal, addressed.
   *
   * The prose above says it in a sentence meant for a button label at the pit
   * station. The briefing room's own wall needs the fact rather than the
   * sentence, so it can raise the alert in the room that is actually in the way
   * (briefing/room-blocked.ts). Empty whenever `allowed`.
   *
   * TWO ENTRIES IS A REAL ANSWER, not a hedge: when the record has lost which
   * room was theirs the group returns to whichever is open, so the refusal is
   * "both are busy" and both rooms are equally the cause. Telling only one of
   * them to get moving would be a guess with a 50% chance of shouting at the
   * wrong room.
   */
  blockedRooms: BriefingRoom[];
}

/**
 * The gate itself — PURE, so it can be asked twice from different places
 * without two copies of the rule.
 *
 * Split out because the pulse already holds both rooms in hand (one MGET for
 * every wall in the building) and re-reading them per lane per 2-second beat
 * would be three more Redis round trips on the one poll that is deliberately a
 * fixed handful. The reads stay in `postRaceGate` below; the decision lives
 * here and both callers get the identical verdict.
 */
export function postRaceGateFrom(
  room: BriefingRoom | null,
  rooms: Record<BriefingRoom, BriefingRoomState | null>,
): PostRaceGate {
  if (room) {
    const occupant = rooms[room];
    if (occupant) {
      return {
        allowed: false,
        reason: `the ${room} room is still briefing${
          occupant.heatNumber != null ? ` Session ${occupant.heatNumber}` : ""
        } — post-race calls the race back into it, so it must be empty first`,
        short: `${room} room busy`,
        blockedRooms: [room],
      };
    }
    return { allowed: true, reason: null, short: null, blockedRooms: [] };
  }
  if (rooms.red && rooms.blue) {
    return {
      allowed: false,
      reason:
        "both briefing rooms are busy — post-race calls the race back in, so a room must be empty first",
      short: "rooms busy",
      blockedRooms: ["red", "blue"],
    };
  }
  return { allowed: true, reason: null, short: null, blockedRooms: [] };
}

export async function postRaceGate(sessionId: string): Promise<PostRaceGate> {
  const [briefed, rooms] = await Promise.all([
    sessionBriefed(sessionId).catch(() => null),
    readBriefingRooms(VENUE).catch(() => ({ red: null, blue: null }) as const),
  ]);
  return postRaceGateFrom(briefed?.room ?? null, rooms);
}

/* ── the POST-RACE cue ─────────────────────────────────────────────────── */

/**
 * The solo post: this track's zone, the room-phrase clip where it applies,
 * and the lane release.
 *
 * THE ANNOUNCEMENT NAMES THE ROOM (owner 2026-08-16). The returning group's
 * room rides the pitIn slot from the send; the briefed marker is the
 * fallback for a slot written before the field existed or hand-placed from
 * Override. Candidates are tried in order and the generic `post` is always
 * last — a room clip the Core does not know yet fails its play, releases
 * the claim, and the plain announcement still sounds on the same press.
 * ONE one-shot whichever version plays: same clip/cue split as the
 * big-race pre.
 *
 * MEGA ONLY (owner 2026-08-16: "this only happens on Mega"). The room is
 * only ambiguous when two rooms serve one circuit; a split night's zone
 * already carries its own post clip that knows its room, and it plays
 * exactly as it always has — no extra attempt, no file dependency.
 */
async function playPostOn(
  track: TrackKey,
  returning: NonNullable<PitLaneFeed["pitIn"]>,
): Promise<PlayCueResult> {
  const briefedRoom = (await sessionBriefed(returning.sessionId).catch(() => null))?.room ?? null;
  const room = returning.room ?? briefedRoom;
  const roomForClip = track === "mega" ? room : null;
  let result: Awaited<ReturnType<typeof claimAndPlay>> = {
    outcome: "failed",
    error: "the PA did not start the cue",
  };
  for (const clip of postClipCandidates(roomForClip)) {
    result = await claimAndPlay(track, "post", returning.sessionId, clip);
    if (result.outcome !== "failed") break;
  }
  if (result.outcome === "failed") return { ok: false, error: result.error };
  if (result.outcome === "already") {
    // Same cycle, pressed again — re-assert the release (see playPostRace for
    // why this is safe): if a straggling finish marker re-raised the hold
    // after the first press, this press is how staff clear it.
    await markRacePitted(track);
    return {
      ok: true,
      alreadyPlayed: true,
      atMs: result.atMs ?? undefined,
      sessionId: returning.sessionId,
      zone: track,
    };
  }

  await recordPost(track, returning, briefedRoom);
  // The release. markRacePitted resolves the racing group itself and writes
  // its own insurance row — one code path for this stamp, whoever presses.
  await markRacePitted(track);
  return { ok: true, atMs: result.atMs, sessionId: returning.sessionId, zone: track };
}

/**
 * THE SYNCED POST: both pits pressed inside the window, so ONE announcement
 * on the mega zone and both lanes released. The generic `post` plays — the
 * room-phrase files are Mega-night clips (playPostOn), and on a split night
 * each group returns to its own room, which is what the generic clip says.
 * The partner is re-resolved and re-gated at play time, exactly as its own
 * press would have been.
 */
async function playPostSynced(
  track: TrackKey,
  returning: NonNullable<PitLaneFeed["pitIn"]>,
  partner: TrackKey,
  partnerSessionId: string,
): Promise<PlayCueResult> {
  const pLane = await readPitLane(partner);
  const pResolved = await resolvePostSubject(pLane);
  const refusePartner = async (error: string): Promise<PlayCueResult> => {
    const solo = await playPostOn(track, returning);
    return settleSync(
      "post",
      { track, sessionId: returning.sessionId, result: solo },
      { track: partner, sessionId: partnerSessionId, result: { ok: false, error } },
    );
  };
  if (!pResolved.ok) return refusePartner(pResolved.error);
  if (pResolved.returning.sessionId !== partnerSessionId) {
    return refusePartner("the race in the pit changed while syncing — press again");
  }
  if (!pResolved.gate.allowed) {
    return refusePartner(pResolved.gate.reason ?? "the briefing room is not empty yet");
  }
  // BOTH zones must be clear NOW, not just the partner's: the hold gave the
  // stay-seated loop up to five seconds to start on either pit, and zones run
  // independently — a loop left sounding on one pit would play on under the
  // mega announcement. One fresh read, two verdicts (mega, if sounding, names
  // itself in both; stopping it twice is harmless). A REAL clip on this track
  // refuses both presses — the partner's press would have been refused for
  // the same reason on its own.
  const live = await readQsysTruth({ fresh: true });
  const [mineCleared, pCleared] = await Promise.all([
    yieldStaySeated(paBusyIn(track, live)),
    yieldStaySeated(paBusyIn(partner, live)),
  ]);
  if (!mineCleared.cleared) {
    const busy: PlayCueResult = { ok: false, error: mineCleared.error ?? "the PA is busy" };
    return settleSync(
      "post",
      { track, sessionId: returning.sessionId, result: busy },
      { track: partner, sessionId: partnerSessionId, result: busy },
    );
  }
  if (!pCleared.cleared) return refusePartner(pCleared.error ?? "the PA is busy");

  const sides = [
    { track, returning },
    { track: partner, returning: pResolved.returning },
  ] as const;
  const briefedRooms = await Promise.all(
    sides.map(
      async (s) => (await sessionBriefed(s.returning.sessionId).catch(() => null))?.room ?? null,
    ),
  );
  const claims = await Promise.all(sides.map((s) => claimCue("post", s.returning.sessionId)));
  const claimedTracks = sides.filter((_, i) => claims[i].claimed).map((s) => s.track);
  const zone = syncedZoneFor(claimedTracks);

  const resultFor = (i: number, play: { atMs: number } | null): PlayCueResult => {
    const claim = claims[i];
    if (!claim.claimed) {
      return {
        ok: true,
        alreadyPlayed: true,
        atMs: claim.atMs ?? undefined,
        sessionId: sides[i].returning.sessionId,
        zone: sides[i].track,
      };
    }
    return {
      ok: true,
      atMs: play?.atMs ?? claim.atMs,
      sessionId: sides[i].returning.sessionId,
      synced: zone === "mega",
      zone: zone ?? sides[i].track,
    };
  };

  if (!zone) {
    // Both already sounded — two re-asserted releases, as playPostOn does.
    await Promise.all(sides.map((s) => markRacePitted(s.track)));
    return settleSync(
      "post",
      { track, sessionId: returning.sessionId, result: resultFor(0, null) },
      { track: partner, sessionId: partnerSessionId, result: resultFor(1, null) },
    );
  }

  // Both claimed → mega, generic clip. One claimed → that pit's own zone; on
  // a split night its clip is the generic one too (room phrases are Mega's).
  const clip: QsysClip = "post";
  const play = await playQsysCue(zone, clip);
  const claimedKeys = claims.flatMap((c) => (c.claimed ? [c.key] : []));
  if (!play.ok) {
    await releaseClaims(claimedKeys);
    const failed: PlayCueResult = {
      ok: false,
      error: play.error ?? "the PA did not start the cue",
    };
    return settleSync(
      "post",
      { track, sessionId: returning.sessionId, result: failed },
      { track: partner, sessionId: partnerSessionId, result: failed },
    );
  }
  const atMs = Math.min(...claims.flatMap((c) => (c.claimed ? [c.atMs] : [])));
  await settleClaims(claimedKeys, atMs, play.durationS, clip);
  console.log(`[pit] synced post on ${zone} for ${claimedTracks.join("+")}`);

  for (const [i, s] of sides.entries()) {
    if (claims[i].claimed) await recordPost(s.track, s.returning, briefedRooms[i]);
    await markRacePitted(s.track);
  }
  return settleSync(
    "post",
    { track, sessionId: returning.sessionId, result: resultFor(0, { atMs }) },
    { track: partner, sessionId: partnerSessionId, result: resultFor(1, { atMs }) },
  );
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
  const resolved = await resolvePostSubject(lane);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (!resolved.gate.allowed) {
    return { ok: false, error: resolved.gate.reason ?? "the briefing room is not empty yet" };
  }
  // Same yield rule as pre: the stay-seated loop stops for the announcement
  // that answers it, and only for that.
  const cleared = await yieldStaySeated(await paBusy(track));
  if (!cleared.cleared) return { ok: false, error: cleared.error ?? "the PA is busy" };

  const sync = await syncWithPartner("post", track, resolved.returning.sessionId);
  if (sync.kind === "relayed") return sync.result;
  if (sync.kind === "lead") {
    return playPostSynced(track, resolved.returning, sync.partner, sync.partnerSessionId);
  }
  const result = await playPostOn(track, resolved.returning);
  if (sync.heldLead) {
    await publishSyncResult("post", track, { ...result, sessionId: resolved.returning.sessionId });
  }
  return result;
}
