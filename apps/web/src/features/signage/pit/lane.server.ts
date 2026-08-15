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
    room: BriefingRoom | null;
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
 * THE "KARTS RETURNING" HOLD IS BACK ON (2026-08-14, same day it was parked).
 *
 * The designed flow: a race finishes → the lane is unsafe while karts come
 * in → a human who can SEE the lane releases it, and only then does the board
 * say it is safe to seat. Never a timer, deliberately — the hold is a safety
 * statement.
 *
 * It was parked earlier today because the release press lived on the CHECK-IN
 * board, where the person can't see the lane and never pressed it — a finished
 * race sat behind an amber flash all evening. The press now has the home the
 * parking note asked for: the pit station (/admin/{token}/pit), where PLAYING
 * THE POST-RACE ANNOUNCEMENT is the release (pit/audio.server.ts — the press
 * makes sound, so it happens). The check-in board's pit-lane button stays as
 * the manual override for a night the PA cannot play.
 *
 * While this is false a finished race just LEAVES the lane; everything that
 * implements the hold below and in pit-board.ts keeps working either way.
 */
const KARTS_RETURNING_HOLD = true;

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
  // One read per track, shared by both slots below.
  const live = await readLiveHeat(track);

  /**
   * THE STAGED GROUP — whoever is waiting on the green, wherever they stand.
   *
   * ONE PREDICATE, TWO POSSIBLE SOURCE SLOTS (owner 2026-08-14: "the existing
   * trigger from holding to race should still exist. Same trigger from karts to
   * race"). The test for "have they gone out" is untouched below; the only thing
   * In Karts changed is where the group being tested is read from. That is what
   * makes the two paths provably identical rather than merely similar — there is
   * no second copy of this rule to drift.
   *
   * Karts wins when both are filled: it is the later stage, so it is the group
   * closer to the flag. A group can only be in one of the two anyway (every
   * writer below vacates the other), but reading it in this order means a lane
   * that somehow held both still promotes the right one.
   */
  const staged = karts ?? holding;
  if (staged) {
    // HOLDING PERSISTS THROUGH THE RACE (owner 2026-08-13: "our session
    // follows the race marked in holding; green flag + active countdown moves
    // it to racing"). The start marker fires at PHASE ONE of the two-phase
    // start — karts rolling out, clock armed static, stragglers still being
    // seated — so it must NOT promote. What ends a staged claim server-side
    // is the FINISH marker (the race demonstrably ran) or the next group
    // taking the seats (see sendToHolding's displacement); the wall's own
    // holding→racing presentation is the client's counting verdict.
    //
    // Note this is exactly why In Karts exists as a stage: phase one of the
    // start IS "they are in the karts", and the pre-message that announces it
    // is the signal this promotion has always had to refuse.
    const finished = await readRaceFinishedMarker(staged.sessionId).catch(() => null);
    // Either witness will do: the broadcast's own finish marker, or the timing
    // socket showing this heat on track (or a later one loaded). See
    // holdingHasGoneOut.
    const goneOut = finished == null && (await liveSaysGoneOut(track, live, staged.heatNumber));
    if (finished != null || goneOut) {
      racing = {
        sessionId: staged.sessionId,
        heatNumber: staged.heatNumber,
        room: staged.room,
      };
      // ONLY THE SLOTS NAMING THE PROMOTED SESSION. Blanking both would erase
      // the group staff just sent to the seats behind a group already in the
      // karts — which is the normal shape of a busy night, not an edge case.
      // Both are cleared when both name this session, so a lane that somehow
      // held one group twice cannot leave a stale copy behind.
      if (holding?.sessionId === staged.sessionId) holding = null;
      if (karts?.sessionId === staged.sessionId) karts = null;
    }
  }

  const stagedOut = {
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
  };

  if (!racing) {
    return { ...stagedOut, racing: null };
  }

  const finish = await readRaceFinishedMarker(racing.sessionId).catch(() => null);
  // The broadcast's own stamp when we have it; the socket's observation when we
  // do not, so a race that is demonstrably over stops reading as still running.
  const finishedAtMs =
    finish?.endedAtMs ?? (await liveSaysFinishedAtMs(track, live, racing.heatNumber));
  let pittedAtMs =
    stored.pitted && stored.pitted.sessionId === racing.sessionId ? stored.pitted.atMs : null;

  /**
   * POST PLAYED = RETURNED, derived at READ time (owner 2026-08-14: "when it
   * is in that hold state, check to see if post was played, it seems like it
   * can get stuck"). The press writes the pitted stamp once; a finish witness
   * landing AFTER that press (a bridge-reconnect replay, the socket's
   * minute-sampled observation) used to out-rank it and re-raise a hold
   * nothing on the pit page could clear — the post one-shot was already
   * burned. The post cue's own stamp is durable and session-keyed, so a hold
   * whose session demonstrably had its post played releases itself, every
   * read, forever. One extra Redis GET, paid only while a hold would
   * otherwise be live.
   */
  if (finishedAtMs != null && (pittedAtMs == null || pittedAtMs < finishedAtMs)) {
    const post = await readCueStamp("post", racing.sessionId).catch(() => null);
    if (post) pittedAtMs = Math.max(post.atMs, finishedAtMs);
  }

  /**
   * THE KARTS ARE BACK, SO THE LANE IS CLEAR (owner 2026-08-14: "62 blue was
   * posted and wasn't cleared").
   *
   * A pitted stamp is a person standing at the pit saying the karts are fully
   * in. That is a statement that the race is OVER, and a better witness to it
   * than anything on the wire — so it ends the racing claim on its own, without
   * waiting for a finish marker to agree.
   *
   * It had no such power, and blue 62 showed what that costs. The venue's finish
   * marker never arrived (the bridge is silent for hours at a time), and the
   * socket's second opinion had aged out, so `finishedAtMs` was null. Post was
   * pressed at 11:41:58 and the stamp landed — but every consumer gates on the
   * finish: `holdLive` needs it, so the desk badge read RACING instead of KARTS
   * COMING IN and hid its "Race returned" press; `playPostRace` needs it, so the
   * pit station refused to play post again. A group who had been back in the pit
   * for minutes sat on two walls as still on track, with no control anywhere in
   * the building able to clear them.
   *
   * A stamp OLDER than the finish it answers is still a stale stamp from the
   * previous cycle and still does not clear the new hold — that rule is what the
   * comparison below preserves.
   */
  if (pittedAtMs != null && (finishedAtMs == null || pittedAtMs >= finishedAtMs)) {
    return { ...stagedOut, racing: null };
  }

  // PARKED: a finished race leaves the lane instead of holding it. See
  // KARTS_RETURNING_HOLD. `pitted` still clears it too, so a night that was
  // already mid-flow when this shipped behaves the same.
  if (!KARTS_RETURNING_HOLD && finishedAtMs != null) {
    return { ...stagedOut, racing: null };
  }

  return {
    ...stagedOut,
    racing: {
      sessionId: racing.sessionId,
      heatNumber: racing.heatNumber,
      finishedAtMs,
      pittedAtMs,
    },
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
export async function sendToHolding(args: SendToHoldingArgs): Promise<{ ok: true }> {
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
  const displaced = !samePress && staged && staged.sessionId !== args.sessionId ? staged : null;
  const racing = displaced
    ? {
        sessionId: displaced.sessionId,
        heatNumber: displaced.heatNumber,
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

export type LaneSlot = "holding" | "karts" | "racing";

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
  } else {
    next.racing = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
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
  const racing = resolved.racing;
  if (!racing) {
    return { ok: false, error: "no race is out on that track — nothing to return" };
  }

  // The insurance row: when the group was fully back in the pit. The room on
  // the row is the room they will hand kit into — the one they were briefed
  // in — read from the lane first and the briefed marker as fallback.
  const roomFromLane =
    stored?.racing?.sessionId === racing.sessionId
      ? stored.racing.room
      : stored?.holding?.sessionId === racing.sessionId
        ? stored.holding.room
        : null;
  const room =
    roomFromLane ?? (await sessionBriefed(racing.sessionId).catch(() => null))?.room ?? null;
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
      action: "pitted",
    });
  }

  await writeStoredLane(track, {
    holding: stored?.holding ?? null,
    karts: stored?.karts ?? null,
    racing: stored?.racing ?? null,
    pitted: { sessionId: racing.sessionId, atMs: Date.now() },
  });
  return { ok: true, sessionId: racing.sessionId };
}
