import "server-only";

/**
 * The pit lane's state — who is seated, who is racing, and whether the lane
 * is safe. Written by two staff presses on the check-in station and read by
 * the pit boards on the 2-second pulse.
 *
 * THE TWO PRESSES (owner 2026-08-13):
 *
 *   SEND TO HOLDING — after the briefing. The group leaves the room for the
 *   pit seats, which FREES THE ROOM (a race can only return to a room with
 *   nobody briefing in it) and tells the board its group is seatable. The
 *   room's occupancy is closed in the insurance log with reason "holding";
 *   the check-in board's briefed marker is deliberately LEFT ALONE — unlike
 *   clearRoom, this send must not put the heat back on the check-in wall.
 *
 *   RACE RETURNED (pitted) — the finished race's karts are fully back in the
 *   lane. THIS is what releases the board's hold: a race finishing starts the
 *   hold automatically (the venue's own finish marker), but only a human who
 *   can see the lane says when it is safe again. Never a timer.
 *
 * WHO IS RACING IS DERIVED, NEVER SWEPT. The stored state only records what
 * staff said ("this session is in holding"); whether that session has since
 * green-flagged is answered at read time by the RaceStart marker the timing
 * webhook writes. A crash between the flag and a poll therefore costs
 * nothing — the next read resolves the same answer from the same facts.
 *
 * Same posture as briefing/state.server.ts: Neon rows first (the record),
 * Redis second (the display), and every export swallows — a Redis blip may
 * cost a wall animation, never a staff action that already wrote its row.
 */
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";
import { afterResponse } from "../after-response.server";
import { primeFastRoster } from "./fast-roster.server";
import { bookmarkBriefingEndAfter } from "../briefing/bookmarks.server";
import { recordBriefingEvent, type BriefingEndReason } from "../briefing/events-db";
import { readRaceFinishedMarker } from "../briefing/race-finish.server";
import { liveHeatKey, type LiveHeat } from "../briefing/race-state-watch.server";
import { clearBriefingRoom, sessionBriefed } from "../briefing/state.server";
import type { BriefingRoom } from "../briefing/types";
import type { TrackKey } from "../track";
import { readCueStamp } from "./audio-stamps.server";
import { liveHeatIsLaterThan } from "./day-schedule.server";
import { holdingAvailability } from "./holding-availability";
import { EMPTY_PIT_LANE, type PitLaneFeed, type PitLanes } from "./pit-board";

const VENUE = "FT";
const PIT_TRACKS: TrackKey[] = ["blue", "red", "mega"];

/** Outlives any race night; short enough that Redis stays display state. */
const LANE_TTL_SECONDS = 12 * 3600;

/** What staff said, verbatim. The resolved view (PitLaneFeed) is computed
 *  from this plus the start/finish markers at read time.
 *
 *  `karts` is absent from lanes written before it existed, so every read of it
 *  is `?? null` — a lane mid-flow when this shipped must keep resolving. */
interface StoredPitLane {
  holding: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    room: BriefingRoom | null;
    atMs: number;
  } | null;
  /** Climbed into the karts, waiting on the green. Optional on the stored
   *  shape because it post-dates the key. */
  karts?: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    room: BriefingRoom | null;
    atMs: number;
  } | null;
  racing: {
    sessionId: string;
    heatNumber: number | null;
    /** Carried forward from the staged slot on promotion, so a group does not
     *  lose its level the moment it takes the track — the idle pit board names
     *  the type at every stage, and `pitIn` derives its own from this. Optional
     *  on the stored shape because it post-dates the key. */
    raceType?: string | null;
    room: BriefingRoom | null;
  } | null;
  /**
   * Back in the pit, post announcement owed. Normally DERIVED rather than
   * stored — resolveLane recomputes it from `racing` plus the finish witness on
   * every read, so a crash between the flag and a poll costs nothing. It is
   * stored only when a human places a group here by hand from Override.
   */
  pitIn?: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    room: BriefingRoom | null;
    finishedAtMs: number | null;
    atMs: number;
    /** Filled at resolve time from the post cue stamp — see clearAnsweredPitIn.
     *  Optional because a hand-placed slot from Override has neither. */
    postRaceAtMs?: number | null;
    postRaceDurationS?: number | null;
  } | null;
  /** The staff "race returned" stamp, tied to the session it answered. */
  pitted: { sessionId: string; atMs: number } | null;
}

function laneKey(track: TrackKey): string {
  return `pit:lane:${VENUE}:${track}`;
}

async function readStoredLane(track: TrackKey): Promise<StoredPitLane | null> {
  try {
    const raw = await redis.get(laneKey(track));
    return raw ? (JSON.parse(raw) as StoredPitLane) : null;
  } catch {
    return null;
  }
}

async function writeStoredLane(track: TrackKey, lane: StoredPitLane): Promise<void> {
  try {
    await redis.set(laneKey(track), JSON.stringify(lane), "EX", LANE_TTL_SECONDS);
  } catch {
    /* the durable event row is already written — see the header */
  }
}

/**
 * THE "KARTS RETURNING" HOLD IS NOW A SLOT, NOT A FLAG (2026-08-15).
 *
 * The designed flow has not changed: a race finishes → the lane is unsafe while
 * karts come in → a human who can SEE the lane releases it, and only then does
 * the board say it is safe to seat. Never a timer, deliberately — the hold is a
 * safety statement, and the release is the pit station PLAYING THE POST-RACE
 * ANNOUNCEMENT (pit/audio.server.ts — the press makes sound, so it happens).
 *
 * What changed is where that state lives. It used to be a boolean const plus a
 * comparison of two timestamps hung off the `racing` slot, which meant a
 * finished race had to stay in `racing` to be held — and the next group going
 * out overwrote it. The hold is now the `pitIn` slot being occupied: one fact,
 * one place, and a returning group that cannot be displaced by an outgoing one.
 */

/**
 * HAS THE TRACK MOVED ON PAST THIS HEAT?
 *
 * THE BRIDGE-DOWN FALLBACK (owner 2026-08-14, live: "18 is stuck in holding and
 * never moved to racing… 17 is stuck racing"). Everything below promotes on the
 * venue broadcast's finish marker, which arrives over the kart bridge — and that
 * bridge went silent at 07:02 that day and stayed silent for seven hours while
 * heats kept running. With no marker there is no promotion, so a group sat in
 * the seats on the board long after they had raced, and the group ahead of them
 * stayed "on track" all evening.
 *
 * The timing socket is a second, independent witness, sampled once a minute by
 * the pause watcher and published as a plain key (race-state-watch.server.ts).
 * A heat SCHEDULED LATER being loaded on that track is proof this one is over.
 * Later by the clock, never by the number — see liveSaysGoneOut.
 *
 * Deliberately conservative, because being wrong here puts a group on track who
 * is sitting in the pits:
 *   • strictly later, never equal — the heat currently loaded is the one being
 *     run, not a finished one;
 *   • the reading must be FRESH, so a stale key from hours ago cannot retire
 *     tonight's group;
 *   • absent, unreadable or older heat ⇒ no opinion, and the marker rules below
 *     are left to decide exactly as before.
 *
 * It can only ever ADD a promotion the finish marker would have made anyway, so
 * a working bridge behaves identically.
 */
const LIVE_HEAT_FRESH_MS = 10 * 60_000;

/**
 * Has this holding group gone out? Two ways to be sure, both from the socket.
 *
 * ON TRACK NOW — the loaded heat IS this group and the clock is doing
 * something (running, paused, or already finished). This is the answer to
 * "it should move from holding to race when that session starts on track,
 * should it not?" (owner 2026-08-14) — yes, and this is what makes it possible.
 * It could not be done from the broadcast's RaceStart, which fires at phase one
 * of the two-phase start with karts rolling out and stragglers still being
 * seated (see the note below), so promoting on it would have emptied the seats
 * while staff were still filling them. The socket's run state is the green flag
 * plus an active countdown — the exact thing the owner described on 2026-08-13
 * — rather than the intent to start one.
 *
 * SUPERSEDED — a strictly LATER heat is loaded, so whatever happened to this
 * one, it is over. This is the recovery path for a night when the broadcast
 * never told us anything at all.
 *
 * `none` is not an answer: a track sitting between heats says nothing about the
 * group in the seats. Nor is a stale reading, nor an absent one.
 */
async function readLiveHeat(track: TrackKey): Promise<LiveHeat | null> {
  try {
    const raw = await redis.get(liveHeatKey(track));
    if (!raw) return null;
    const live = JSON.parse(raw) as LiveHeat;
    if (!Number.isFinite(live?.heatNumber) || !Number.isFinite(live?.atMs)) return null;
    if (Date.now() - live.atMs > LIVE_HEAT_FRESH_MS) return null;
    return live;
  } catch {
    return null;
  }
}

/**
 * Is this heat out on track (or already past)? See the note above.
 *
 * "PAST" IS A CLOCK COMPARISON, NEVER A NUMBER ONE (tasks/lessons.md
 * 2026-07-11). `heatNumber` is Pandora's CREATION order: a staff-inserted
 * session takes the day-max number, so `live.heatNumber > ours` would have read
 * one inserted heat loading on track as proof that every earlier heat was over —
 * and this branch SWEEPS A GROUP OUT OF THE HOLDING SEATS. `liveHeatIsLaterThan`
 * looks both heats up on today's schedule and compares `scheduledStart`, and
 * fails closed when it cannot.
 */
async function liveSaysGoneOut(
  track: TrackKey,
  live: LiveHeat | null,
  heatNumber: number | null,
): Promise<boolean> {
  if (!live || heatNumber == null) return false;
  if (live.heatNumber === heatNumber) return live.state !== "none";
  return liveHeatIsLaterThan(track, live.heatNumber, heatNumber);
}

/**
 * WHEN THIS HEAT FINISHED, according to the socket — the other half of the same
 * fallback, and the half that was missing.
 *
 * Promoting a group to `racing` without a finish time left them reading RACING
 * for as long as the board was up: the rail only stops counting once it has an
 * end, and the end came exclusively from the broadcast marker (owner 2026-08-14,
 * on a board still showing "Session 25 · racing · 44 min total so far" for a
 * race that was long over). So the same witness that says a heat went out is now
 * also allowed to say it is done.
 *
 * The timestamp is WHEN WE SAW IT, not the venue's own stamp — the socket has no
 * end time to give. That is honest and it is late by at most one sample, which
 * is the right direction: a hold that starts a minute late is a board catching
 * up, while one that starts early would say the lane is safe before it is. A
 * real marker always wins when it exists.
 */
/** First-sighting pin for the socket witness — see the call site. Fails to
 *  the fresh value: a Redis blip costs stability for one read, never a lane. */
async function pinWitnessedFinish(sessionId: string, atMs: number): Promise<number> {
  const key = `pit:live-finished:${sessionId}`;
  try {
    const claimed = await redis.set(key, String(atMs), "EX", 12 * 3600, "NX");
    if (claimed === "OK") return atMs;
    const raw = await redis.get(key);
    const stored = raw == null ? NaN : Number(raw);
    return Number.isFinite(stored) ? stored : atMs;
  } catch {
    return atMs;
  }
}

async function liveSaysFinishedAtMs(
  track: TrackKey,
  live: LiveHeat | null,
  heatNumber: number | null,
): Promise<number | null> {
  if (!live || heatNumber == null) return null;
  if (live.heatNumber === heatNumber) return live.state === "finished" ? live.atMs : null;
  // Same schedule comparison as liveSaysGoneOut, and for the same reason.
  return (await liveHeatIsLaterThan(track, live.heatNumber, heatNumber)) ? live.atMs : null;
}

/**
 * Resolve a stored lane to what is true now: a holding group whose start
 * marker has landed IS the racing group, whatever the stored state says.
 */
async function resolveLane(stored: StoredPitLane | null, track: TrackKey): Promise<PitLaneFeed> {
  if (!stored) return EMPTY_PIT_LANE;

  let holding = stored.holding;
  let karts = stored.karts ?? null;
  let racing = stored.racing;
  let pitIn = stored.pitIn ?? null;
  // One read per track, shared by every slot below.
  const live = await readLiveHeat(track);

  /**
   * A PIT SLOT THAT HAS BEEN ANSWERED IS SPENT — step 3, as a helper, because it
   * has to run at TWO points in the pass.
   *
   * It used to run only at the end, which meant the slot still looked occupied
   * while the promotion below was deciding what to do, and a group that had
   * already finished had nowhere to settle. Running it first frees the slot the
   * moment the previous group's post lands; running it again afterwards catches
   * whoever just moved in.
   *
   * "Answered" is the pitted press or the post cue's own stamp, both session-
   * keyed. No time comparison: a session occupies the pit once, so a stamp
   * bearing its id can only be about this stage.
   */
  const clearAnsweredPitIn = async (): Promise<void> => {
    if (!pitIn) return;
    const pittedHere = stored.pitted?.sessionId === pitIn.sessionId;
    if (pittedHere) {
      pitIn = null;
      return;
    }
    const post = await readCueStamp("post", pitIn.sessionId).catch(() => null);
    if (!post) return;

    /**
     * THE SLOT SURVIVES THE CLIP (owner 2026-08-15, the split rail).
     *
     * It used to clear the moment a post stamp existed, so the returning group
     * disappeared off the board on the button press and "post playing" / "post
     * played" were states nothing could ever render. The announcement is what
     * calls the race back in, so the lane is not finished until it has actually
     * played through — clearing on the START of it was always slightly early.
     *
     * A stamp with no duration (legacy shape) clears immediately, as before.
     */
    const endsAtMs = post.durationS == null ? null : post.atMs + post.durationS * 1000;
    if (endsAtMs == null || Date.now() >= endsAtMs) {
      pitIn = null;
      return;
    }
    pitIn = { ...pitIn, postRaceAtMs: post.atMs, postRaceDurationS: post.durationS };
  };

  /**
   * ── 1. THE CHEQUERED FLAG PUTS A RACE INTO THE PIT ──────────────────────
   *
   * On track means ON TRACK now (owner 2026-08-15). A group whose race has
   * demonstrably ended is not racing — they are rolling back into the lane with
   * a post announcement still owed, which is its own stage with its own slot.
   *
   * Moving them HERE rather than leaving them in `racing` is what stops the next
   * group destroying them: promotion below writes `racing`, and while a finished
   * race was still sitting in it, going out overwrote the returning group and
   * took the only record that post was owed with it.
   */
  if (racing) {
    const finish = await readRaceFinishedMarker(racing.sessionId).catch(() => null);
    const witnessedAtMs =
      finish?.endedAtMs == null ? await liveSaysFinishedAtMs(track, live, racing.heatNumber) : null;
    /**
     * THE WITNESS TIME IS PINNED TO ITS FIRST SIGHTING (owner 2026-08-14: "Post
     * was completed on blue but the HOLD stayed up"). live.atMs is the pause
     * watcher's SAMPLE time and advances every sample — so on a night the finish
     * marker never lands, a derived finish crept forward past every stamp that
     * answered it. First sighting wins (NX), the same rule the finish marker
     * itself follows: a finish time, whoever witnessed it, never moves.
     */
    const finishedAtMs =
      finish?.endedAtMs ??
      (witnessedAtMs != null ? await pinWitnessedFinish(racing.sessionId, witnessedAtMs) : null);
    /**
     * A PERSON IS ALSO A WITNESS (owner 2026-08-14: "62 blue was posted and
     * wasn't cleared"). Somebody standing at the pit saying the karts are back
     * is a statement that the race is over — and on a night the bridge is silent
     * and the socket has aged out, it is the ONLY witness there is. Without this
     * a stamped group stayed in `racing` for ever, unclearable from any screen.
     *
     * They land in `pitIn` and step 3 immediately clears them, which is the
     * right path rather than a shortcut: the stamp answers the pit, so the pit
     * is what it has to reach.
     */
    const pittedHere = stored.pitted?.sessionId === racing.sessionId;
    if (finishedAtMs != null || pittedHere) {
      pitIn = {
        sessionId: racing.sessionId,
        heatNumber: racing.heatNumber,
        raceType: racing.raceType ?? null,
        room: racing.room,
        finishedAtMs,
        atMs: finishedAtMs ?? stored.pitted?.atMs ?? Date.now(),
        postRaceAtMs: null,
        postRaceDurationS: null,
      };
      racing = null;
    }
  }

  /**
   * ── 2. THE STAGED GROUP TAKES THE TRACK ─────────────────────────────────
   *
   * THE STAGED GROUP is whoever is waiting on the green, wherever they stand.
   * ONE PREDICATE, TWO POSSIBLE SOURCE SLOTS (owner 2026-08-14: "the existing
   * trigger from holding to race should still exist. Same trigger from karts to
   * race"). The test for "have they gone out" is untouched; the only thing In
   * Karts changed is where the group being tested is read from, so there is no
   * second copy of the rule to drift.
   *
   * Karts wins when both are filled: it is the later stage, so it is the group
   * closer to the flag.
   */
  // Free a spent pit slot before deciding the promotion — see the helper.
  await clearAnsweredPitIn();

  const staged = karts ?? holding;
  if (staged) {
    // HOLDING PERSISTS THROUGH THE RACE (owner 2026-08-13: "our session follows
    // the race marked in holding; green flag + active countdown moves it to
    // racing"). The start marker fires at PHASE ONE of the two-phase start —
    // karts rolling out, clock armed static, stragglers still being seated — so
    // it must NOT promote. That phase IS "they are in the karts", which is
    // exactly the stage In Karts now names.
    const finished = await readRaceFinishedMarker(staged.sessionId).catch(() => null);
    // Either witness will do: the broadcast's own finish marker, or the timing
    // socket showing this heat on track (or a later one loaded).
    const goneOut = finished == null && (await liveSaysGoneOut(track, live, staged.heatNumber));
    if (finished != null || goneOut) {
      /**
       * SUCCESSION PUTS THE LAST GROUP IN THE PIT, NEVER IN THE BIN.
       *
       * One group races at a time, so this group taking the track is proof the
       * last one is off it — even on a night when no finish marker ever arrived
       * for them. They move to `pitIn` with a null finish, because we genuinely
       * never witnessed one; what we know is that they are back, and that post
       * is owed. Overwriting them was the bug.
       */
      if (racing && racing.sessionId !== staged.sessionId) {
        pitIn = {
          sessionId: racing.sessionId,
          heatNumber: racing.heatNumber,
          raceType: racing.raceType ?? null,
          room: racing.room,
          finishedAtMs: null,
          atMs: Date.now(),
          postRaceAtMs: null,
          postRaceDurationS: null,
        };
      }
      racing = {
        sessionId: staged.sessionId,
        heatNumber: staged.heatNumber,
        // THE LEVEL TRAVELS WITH THE GROUP. It was dropped here, which is why
        // `racing` and every `pitIn` derived from it carried a null type — the
        // staged slot is the only thing that knows it, and this is the one
        // moment that knowledge could be handed on.
        raceType: staged.raceType,
        room: staged.room,
      };
      // ONLY THE SLOTS NAMING THE PROMOTED SESSION. Blanking both would erase a
      // group sent to the seats behind a group already in the karts, which is
      // the normal shape of a busy night rather than an edge case.
      if (holding?.sessionId === staged.sessionId) holding = null;
      if (karts?.sessionId === staged.sessionId) karts = null;

      /**
       * A GROUP PROMOTED ON ITS OWN FINISH IS NOT RACING — IT IS BACK.
       *
       * `finished` is one of the two witnesses this promotion accepts, and it is
       * the strongest: you cannot finish without having gone out. But it also
       * says the race is OVER, and step 1 — the only thing that moves a finished
       * race into the pit — has already run for this pass. Without this, such a
       * group lands in `racing` and stays there: resolve does not persist, so
       * every later read recomputes the same result from the same stored state
       * and pins them permanently (Red 12 sat "on track" after finishing,
       * 2026-08-15; Red 10 the same afternoon).
       *
       * Settling it here rather than looping the whole resolve keeps the pass
       * single and cheap, and a group can only cross this line once.
       *
       * The pit slot is only taken if it is FREE. When an earlier group is still
       * in it owing a post, that group is the one staff are working on, and
       * overwriting it would destroy the only record that its post is owed —
       * exactly the bug the succession block above exists to prevent. Leaving
       * this group in `racing` for now is the lesser wrong, and it settles on the
       * read after that pit slot clears.
       */
      if (finished != null && pitIn == null) {
        pitIn = {
          sessionId: racing.sessionId,
          heatNumber: racing.heatNumber,
          raceType: racing.raceType ?? null,
          room: racing.room,
          finishedAtMs: finished.endedAtMs ?? null,
          atMs: finished.endedAtMs ?? Date.now(),
          postRaceAtMs: null,
          postRaceDurationS: null,
        };
        racing = null;
      }
    }
  }

  /**
   * ── 3. THE POST ANNOUNCEMENT CLEARS THE PIT ─────────────────────────────
   *
   * "Post race becomes the item that clears pit in status" (owner 2026-08-15).
   * Either witness will do and both are session-keyed: the pitted stamp the
   * press writes, or the post cue's own durable stamp — which is what heals a
   * night when the stamp landed and something else re-raised the hold.
   *
   * NO TIME COMPARISON ANY MORE, and that is the point of the slot. The old rule
   * had to ask whether a stamp was newer than the finish it answered, because
   * one `racing` slot was reused by every group in turn and a stale stamp could
   * release the next group's hold. A session only ever occupies `pitIn` once, so
   * a stamp bearing its id can only be about this stage.
   */
  await clearAnsweredPitIn();

  return {
    holding: holding
      ? {
          sessionId: holding.sessionId,
          heatNumber: holding.heatNumber,
          raceType: holding.raceType,
          room: holding.room,
          atMs: holding.atMs,
        }
      : null,
    karts: karts
      ? {
          sessionId: karts.sessionId,
          heatNumber: karts.heatNumber,
          raceType: karts.raceType,
          room: karts.room,
          atMs: karts.atMs,
        }
      : null,
    racing: racing
      ? {
          sessionId: racing.sessionId,
          heatNumber: racing.heatNumber,
          raceType: racing.raceType ?? null,
        }
      : null,
    pitIn: pitIn
      ? {
          ...pitIn,
          postRaceAtMs: pitIn.postRaceAtMs ?? null,
          postRaceDurationS: pitIn.postRaceDurationS ?? null,
        }
      : null,
  };
}

/** One track's resolved lane. */
export async function readPitLane(track: TrackKey): Promise<PitLaneFeed> {
  return resolveLane(await readStoredLane(track), track);
}

/** Every track's resolved lane — what the pulse carries. One MGET for the
 *  lanes; the marker reads happen only for tracks that actually hold state. */
export async function readPitLanes(): Promise<PitLanes> {
  const empty: PitLanes = { blue: EMPTY_PIT_LANE, red: EMPTY_PIT_LANE, mega: EMPTY_PIT_LANE };
  try {
    const raw = await redis.mget(...PIT_TRACKS.map((t) => laneKey(t)));
    const out = { ...empty };
    await Promise.all(
      PIT_TRACKS.map(async (track, i) => {
        const value = raw[i];
        if (!value) return;
        try {
          out[track] = await resolveLane(JSON.parse(value) as StoredPitLane, track);
        } catch {
          /* one malformed lane must not cost the other tracks */
        }
      }),
    );
    return out;
  } catch {
    return empty;
  }
}

/* ── the two staff presses ────────────────────────────────────────────── */

export interface SendToHoldingArgs {
  room: BriefingRoom;
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  /**
   * How the room came to be released. Defaults to the staff press.
   *
   * `auto-holding` is the camera sweep having observed the room empty
   * (briefing/auto-holding.ts). It rides the SAME function rather than a
   * parallel one on purpose: the displacement rule below, the room clear, the
   * log write and the bookmark all have to behave identically whoever decided
   * it, and two code paths is how they would stop.
   */
  reason?: Extract<BriefingEndReason, "holding" | "auto-holding">;
}

/**
 * Send a briefed group to the pit seats.
 *
 * ORDERING: Neon first (the room occupancy closes with reason "holding" —
 * that row is the insurance answer to "when did they leave the room"), then
 * the room's display state clears (the room is OPEN for the racing group's
 * return), then the lane records who is seatable. The briefed marker is left
 * standing so the check-in board stays cleared.
 *
 * WHO WAS RACING when this group sat down: the group these seats are being
 * taken FROM. Holding persists through the race by design (see resolveLane),
 * so a new send DISPLACES the previous holding group into racing outright —
 * staff only seat the next group once the last one is out, and succession is
 * the one start signal that needs no marker at all.
 */
export async function sendToHolding(
  args: SendToHoldingArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  /**
   * REFUSE WHEN IT WOULD EVICT A GROUP THAT HAS NOT GONE OUT (owner 2026-08-15:
   * "if holding is full we need to prevent them from hitting send to holding").
   *
   * Blue 27 vanished off every screen after check-in. `holding` is a single
   * slot, and the write below DISPLACES whoever is staged — promoting them to
   * `racing` on the assumption they have just taken the track. That assumption
   * is right in the normal flow, because the stored lane is stale after a real
   * green flag. It is catastrophic when it is wrong: the displaced group is
   * declared racing without ever leaving the seats, and the next press
   * overwrites them with nothing left to say they existed. The blue lane went
   * 26 racing -> 28 holding, and 27 had no keys in Redis at all.
   *
   * So the test is not "is holding full" but the sharper "would this press
   * displace someone who is not actually out" — which still allows the normal
   * back-to-back flow, where the staged group HAS gone racing and the stored
   * lane simply has not caught up.
   *
   * THE RULE ITSELF LIVES IN holding-availability.ts, because the in-room
   * briefing screen has to reach the same verdict to decide whether to offer the
   * button — and the sentence it prints on a disabled button must be the sentence
   * this would have returned. Only the READS stay here: the occupant comes from
   * the stored lane, and the expensive resolve is paid for only when there is
   * actually somebody in the way.
   */
  {
    const current = await readStoredLane(args.track);
    const occupant = current?.holding ?? null;
    if (occupant && occupant.sessionId !== args.sessionId) {
      const resolved = await resolveLane(current, args.track);
      const verdict = holdingAvailability({
        holding: occupant,
        racing: resolved.racing,
        pitIn: resolved.pitIn,
        sessionId: args.sessionId,
      });
      if (!verdict.ok) return verdict;
    }
  }

  const reason = args.reason ?? "holding";
  const endedAtMs = Date.now();

  // Durable first — the room occupancy's explicit end.
  await recordBriefingEvent({
    venue: VENUE,
    businessDay: businessDayYmdET(),
    room: args.room,
    track: args.track,
    sessionId: args.sessionId,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    tier: null,
    action: "ended",
    reason,
  });

  /**
   * MARK THE NVR'S OWN TIMELINE (owner 2026-08-14). A signpost on the footage so
   * a later question can be answered by opening the camera rather than scrubbing.
   *
   * QUEUED FOR AFTER THE RESPONSE, NOT AWAITED. It was awaited at first, and the
   * owner felt it the same evening: "when we hit send to holding the assignment
   * TVs can update a bit faster, takes a few seconds." The press has to free the
   * room and repaint the pit boards; a round trip to the NVR has no business
   * being in front of that. See afterResponse in bookmarks.server.ts.
   */
  bookmarkBriefingEndAfter({
    room: args.room,
    track: args.track,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    atMs: endedAtMs,
    automatic: reason === "auto-holding",
  });

  // The room is free the moment the group walks out of it. Deliberately NOT
  // clearRoom(): that would also un-brief the session and put the heat back
  // on the check-in wall, which is exactly wrong here.
  await clearBriefingRoom(VENUE, args.room);

  const stored = await readStoredLane(args.track);
  // Re-sending the group already in holding is a refresh, not a new cycle —
  // the racing half and its pitted stamp stay exactly as they were.
  const samePress = stored?.holding?.sessionId === args.sessionId;
  /**
   * WHO THESE SEATS ARE BEING TAKEN FROM — the staged group, in whichever slot
   * holds it. Same `karts ?? holding` source as resolveLane's promotion, and
   * for the same reason: once a group has climbed into the karts they are the
   * ones on their way out, and displacing the empty seats behind them would
   * promote nobody while leaving the karts group stranded.
   */
  const staged = stored?.karts ?? stored?.holding ?? null;
  // Resolved once, for two jobs: deciding whether the staged group has actually
  // gone out, and persisting the pit-in group this write would otherwise sever
  // (see the pitIn field on the write below).
  const resolved = await resolveLane(stored, args.track);
  /**
   * ONLY DISPLACE A GROUP THAT HAS ACTUALLY TAKEN THE TRACK.
   *
   * This used to displace whoever was staged, unconditionally, and promote them
   * to `racing` — right when the stored lane was merely stale after a green
   * flag, catastrophic when they were still sitting in the seats. It is also
   * what made "a group in the karts, another in holding" — the normal shape of
   * a busy night — impossible to hold safely: staging the second one evicted
   * the first.
   */
  const stagedIsOut =
    !!staged &&
    (resolved.racing?.sessionId === staged.sessionId ||
      resolved.pitIn?.sessionId === staged.sessionId);
  const displaced =
    !samePress && staged && staged.sessionId !== args.sessionId && stagedIsOut ? staged : null;
  // A displaced group that has already SETTLED INTO THE PIT is back, not out —
  // re-declaring it racing would store one session in two slots at once.
  const racing =
    displaced && resolved.pitIn?.sessionId !== displaced.sessionId
      ? {
          sessionId: displaced.sessionId,
          heatNumber: displaced.heatNumber,
          raceType: displaced.raceType,
          room: displaced.room,
        }
      : (stored?.racing ?? null);
  // Only the slot the displaced group actually vacated is cleared, so a karts
  // group that was NOT the one displaced keeps its place.
  const kartsAfter =
    displaced && stored?.karts?.sessionId === displaced.sessionId ? null : (stored?.karts ?? null);

  await writeStoredLane(args.track, {
    holding: {
      sessionId: args.sessionId,
      heatNumber: args.heatNumber,
      raceType: args.raceType,
      room: args.room,
      atMs: Date.now(),
    },
    karts: kartsAfter,
    racing,
    /**
     * THE PIT-IN GROUP RIDES THE WRITE (owner 2026-08-15: "if a race comes back
     * and another gets moved into holding our post goes away even if not
     * played").
     *
     * `pitIn` is normally DERIVED — resolveLane recomputes it on every read from
     * `stored.racing` plus the finish witness, so it usually has no stored row
     * at all. The displacement above overwrites `stored.racing`, which was that
     * derivation's only anchor: without persisting the resolved slot here, the
     * returning group — hold rail, post-due pill, the whole record that a post
     * announcement is owed — vanished on the press. Persisting the RESOLVED
     * value rather than `stored.pitIn` is deliberate in both directions: it
     * captures a derived group the stored shape never carried, and a resolved
     * null means the slot is genuinely spent (post played, or pitted), which a
     * stale stored copy must not resurrect — the pitted stamp that answered it
     * is dropped by this same write.
     */
    pitIn: resolved.pitIn ? { ...resolved.pitIn } : null,
    pitted:
      stored?.pitted && racing && stored.pitted.sessionId === racing.sessionId
        ? stored.pitted
        : null,
  });

  /**
   * WARM THE BOARD'S ROSTER (owner 2026-08-14: "I need those names to pop right
   * after they hit send to holding").
   *
   * The pit board reads its session straight off the lane we just wrote, so the
   * very next 2-second pulse asks about a session nothing has cached — and pays
   * for a Pandora read inside that pulse. Filling the cache here means the names
   * arrive with the rail rather than a beat or two behind it.
   *
   * After the response, like the bookmark above: this exists to make the wall
   * faster, so it must never make the press slower.
   */
  afterResponse(() => primeFastRoster(args.sessionId, Date.now()));

  return { ok: true };
}

/**
 * THEY ARE IN THE KARTS — the stage between the seats and the green flag.
 *
 * THE TRIGGER IS THE PIT STATION'S "PLAY PRE" BUTTON (owner 2026-08-14: "pit
 * board has a button called play pre. That is what triggers holding to move to
 * karts"). The pre-race announcement is what sends a seated group to their
 * karts, so playPreRace calls this the moment the cue sounds — see
 * audio.server.ts. The desk's override panel can also place a group by hand, for
 * a night when the PA cannot play.
 *
 * THE SEATS ARE FREE THE MOMENT THEY CLIMB IN. That is the entire point of the
 * stage — holding is vacated here, so the next group can be sent over while this
 * one waits on the flag. Nothing else about the lane moves.
 *
 * IDEMPOTENT, because the same message may be delivered twice and the desk reads
 * "in the karts 0:38" off this stamp — restarting that clock on a duplicate
 * would make a group look like they had just got in when they had been sitting
 * there two minutes.
 *
 * It will place a group that was never sent to holding. Deliberately: a missed
 * "send to holding" press is the single most common gap on this board (7 presses
 * across 131 room occupancies, measured 2026-08-13), and a message from the
 * track saying where people physically are outranks a press nobody made.
 */
export async function markInKarts(args: {
  track: TrackKey;
  sessionId: string;
  heatNumber?: number | null;
  raceType?: string | null;
  room?: BriefingRoom | null;
  /** When they got in. Defaults to now; passed explicitly when a message
   *  carries the venue's own stamp. */
  atMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const stored = (await readStoredLane(args.track)) ?? {
    holding: null,
    karts: null,
    racing: null,
    pitted: null,
  };

  // Already out on track. A pre-message arriving late — or replayed — must never
  // pull a racing group back into the karts: that would put one session in two
  // places on every board that reads this lane.
  if (stored.racing?.sessionId === args.sessionId) {
    return { ok: false, error: "that session is already out on track" };
  }

  if (stored.karts?.sessionId === args.sessionId) return { ok: true };

  const from = stored.holding?.sessionId === args.sessionId ? stored.holding : null;

  await writeStoredLane(args.track, {
    ...stored,
    // Only vacate the seats if this is the group sitting in them. A pre-message
    // for a session nobody sent must not evict whoever is actually there.
    holding: from ? null : (stored.holding ?? null),
    karts: {
      sessionId: args.sessionId,
      heatNumber: args.heatNumber ?? from?.heatNumber ?? null,
      raceType: args.raceType ?? from?.raceType ?? null,
      room: args.room ?? from?.room ?? null,
      atMs: args.atMs ?? Date.now(),
    },
  });

  return { ok: true };
}

/**
 * "Race returned" — the karts are fully back in the lane.
 *
 * Applies to whatever the lane resolves the racing group to be. Refuses
 * (ok:false) when there is nothing to return: a stray press with an empty
 * lane must not write a stamp that would silently release the NEXT hold.
 */
/**
 * STAFF OVERRIDE — put a session in a lane slot by hand, or empty the slot.
 *
 * WHY THIS EXISTS. Every automatic transition on this board depends on
 * something outside the building: Pandora naming the called heat, the timing
 * webhook stamping a start or a finish, the live socket reaching the desk. On
 * 2026-08-13/14 all three failed in one night — Pandora's races/current
 * returned 500 for hours, start markers never arrived, finishes had to be
 * written by hand from a script — and the desk had no way to say what staff
 * could plainly see. Every correction meant somebody with a Redis client.
 *
 * So the board gets the same power the script had, with the same guard rails.
 *
 * ONE SESSION PER SLOT, ENFORCED HERE. A lane holds one group in the seats and
 * one group on track; putting a second into either would make the board lie in
 * a way staff could not see (owner 2026-08-14: "if something is already in that
 * state it would need changed first before moving another race to that state").
 * The refusal names the occupant, because "clear it first" is only actionable
 * if you know what "it" is. Refusing rather than displacing is deliberate: an
 * override is a claim about the real world, and two claims about one place mean
 * somebody is wrong and should look before overwriting.
 *
 * The stored shape is exactly what the presses write, so nothing downstream can
 * tell an override from an ordinary night.
 */
export interface LaneSlotOccupant {
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  room: BriefingRoom | null;
}

export type LaneSlot = "holding" | "karts" | "racing" | "pitIn";

export async function overrideLaneSlot(args: {
  track: TrackKey;
  slot: LaneSlot;
  /** Null empties the slot. */
  occupant: LaneSlotOccupant | null;
  /** Replace whatever is there, even a different session. The desk asks for
   *  this only after showing the staff member who is being displaced. */
  force?: boolean;
}): Promise<{ ok: boolean; error?: string; occupiedBy?: string }> {
  const stored = (await readStoredLane(args.track)) ?? {
    holding: null,
    racing: null,
    pitted: null,
  };

  const current = stored[args.slot];
  if (!args.force && args.occupant && current && current.sessionId !== args.occupant.sessionId) {
    return {
      ok: false,
      error:
        `${args.track} ${args.slot} already holds ` +
        `${current.heatNumber != null ? `session ${current.heatNumber}` : "another session"}` +
        ` — clear it first`,
      occupiedBy: current.sessionId,
    };
  }

  const next: StoredPitLane = { ...stored };
  if (args.slot === "holding") {
    next.holding = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
          raceType: args.occupant.raceType,
          room: args.occupant.room,
          atMs: Date.now(),
        }
      : null;
  } else if (args.slot === "karts") {
    // Same shape as holding — the two are one "staged" group to every reader,
    // and resolveLane's `karts ?? holding` depends on them staying identical.
    next.karts = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
          raceType: args.occupant.raceType,
          room: args.occupant.room,
          atMs: Date.now(),
        }
      : null;
  } else if (args.slot === "pitIn") {
    /**
     * Placing here by hand is how staff say "they are back in the pit" on a
     * night nothing on the wire will. Clearing it is the manual equivalent of
     * the post announcement — see resolveLane step 3, which also drops a group
     * whose pitted or post stamp has landed.
     */
    next.pitIn = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
          raceType: args.occupant.raceType,
          room: args.occupant.room,
          finishedAtMs: null,
          atMs: Date.now(),
        }
      : null;
    // A hand-cleared pit-in must not be re-created by a stamp that is still
    // sitting there from the press that put them in it.
    if (!args.occupant && next.pitted) next.pitted = null;
  } else {
    next.racing = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
          raceType: args.occupant.raceType,
          room: args.occupant.room,
        }
      : null;

    /**
     * CLEARING RACING MUST ALSO CLEAR WHAT DERIVES IT (owner 2026-08-14: "I
     * can't clear 62 red and its done").
     *
     * `racing` is the one slot on this lane that is not simply stored — a
     * staged group whose race has demonstrably run IS the racing group, decided
     * at read time by resolveLane. So a lane can store `holding: 62` and read
     * back `racing: 62, holding: null`, which is exactly what the desk sees.
     * Emptying the racing slot then wrote `racing: null` over a field that was
     * already null and left the real occupant sitting in `holding`, where the
     * very next poll promoted it again. The button did fire, the write did
     * land, and the session came straight back — for as long as anyone kept
     * pressing it.
     *
     * So: resolve first, find who is actually out there, and take that session
     * out of every stored slot naming it. Matched on sessionId, never heat
     * number — 62 exists on both tracks tonight, and this empties a lane.
     */
    if (!args.occupant) {
      const outSessionId = (await resolveLane(stored, args.track)).racing?.sessionId ?? null;
      if (outSessionId) {
        if (next.holding?.sessionId === outSessionId) next.holding = null;
        if (next.karts?.sessionId === outSessionId) next.karts = null;
      }
    }

    // A pitted stamp belongs to the session it answered. Moving a different
    // group onto the track must not inherit "their karts are already back".
    if (next.pitted && next.pitted.sessionId !== args.occupant?.sessionId) {
      next.pitted = null;
    }
  }

  await writeStoredLane(args.track, next);

  /**
   * The durable trail, so a hand-placed group is still answerable tomorrow.
   *
   * NOT FOR THE KARTS SLOT. This log answers "when did they leave the room" and
   * "when were the karts back" — room occupancy and the pitted call. Climbing
   * into a kart is neither, and there is no honest existing action for it: both
   * "ended" (they left the room, which already happened at holding) and "pitted"
   * (their karts are back, which is the opposite end of the race) would put a
   * false row in an insurance record. A truthful `in-karts` action means a new
   * enum value and a migration — worth doing, but not smuggled into this PR.
   */
  if (args.occupant && args.slot !== "karts") {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room: args.occupant.room ?? "red",
      track: args.track,
      sessionId: args.occupant.sessionId,
      heatNumber: args.occupant.heatNumber,
      raceType: args.occupant.raceType,
      tier: null,
      action: args.slot === "holding" ? "ended" : "pitted",
      reason: "override",
    }).catch(() => {});
  }

  return { ok: true };
}

export async function markRacePitted(
  track: TrackKey,
): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const stored = await readStoredLane(track);
  const resolved = await resolveLane(stored, track);
  /**
   * THE GROUP IN THE PIT, NOT THE ONE ON TRACK (2026-08-15).
   *
   * "Race returned" answers "the karts are fully back in the lane", which is a
   * fact about the group that has COME IN — and since the pitIn slot exists,
   * that is precisely who occupies it. It used to read `racing`, back when a
   * finished race stayed there; on a busy night that meant the press could land
   * on the group that had just gone OUT.
   *
   * Falling back to `racing` when the pit is empty is deliberate: a race with no
   * finish witness at all is still in `racing`, and a human at the lane saying
   * they are back is exactly the witness that was missing.
   */
  const returning = resolved.pitIn ?? resolved.racing;
  if (!returning) {
    return { ok: false, error: "no race is out on that track — nothing to return" };
  }

  // The insurance row: when the group was fully back in the pit. The room on
  // the row is the room they will hand kit into — the one they were briefed
  // in — read from the lane first and the briefed marker as fallback.
  const roomFromLane =
    resolved.pitIn?.sessionId === returning.sessionId
      ? resolved.pitIn.room
      : stored?.racing?.sessionId === returning.sessionId
        ? stored.racing.room
        : stored?.holding?.sessionId === returning.sessionId
          ? stored.holding.room
          : null;
  const room =
    roomFromLane ?? (await sessionBriefed(returning.sessionId).catch(() => null))?.room ?? null;
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
      action: "pitted",
    });
  }

  await writeStoredLane(track, {
    holding: stored?.holding ?? null,
    karts: stored?.karts ?? null,
    racing: stored?.racing ?? null,
    // A hand-placed pit-in is cleared by the same press that clears a derived
    // one — otherwise the override would outlive the announcement that answered
    // it, and the slot would never empty.
    pitIn: stored?.pitIn?.sessionId === returning.sessionId ? null : (stored?.pitIn ?? null),
    pitted: { sessionId: returning.sessionId, atMs: Date.now() },
  });
  return { ok: true, sessionId: returning.sessionId };
}
