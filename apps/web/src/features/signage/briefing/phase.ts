/**
 * The briefing timeline. PURE — no React, no clock reads, no I/O.
 *
 * One send writes a start time. Everything after that is arithmetic:
 *
 *     0 ─────────── video ──────────► d ── helmet ──► d+30s ─► free for the next
 *
 * Deriving instead of remembering is what makes a briefing room survive its own
 * player PC. A TV that reboots four minutes into a five-minute video comes back
 * four minutes into the video, because the only state is `triggeredAtMs` in Redis
 * and the video seeks to `nowMs - triggeredAtMs`. There is no "current phase"
 * anywhere to restore, and no timer to fall out of step with the room next door.
 *
 * The same property makes this testable by passing numbers in — see phase.test.ts.
 */
import {
  ASSIGNED_HOLD_MS,
  HELMET_PHASE_MS,
  NOMINAL_VIDEO_MS,
  type BriefingPhase,
  type BriefingRoomState,
} from "./types";

export interface BriefingTimeline {
  phase: BriefingPhase;
  /** Where in the video to seek, ms. Only meaningful in the `video` phase. */
  videoOffsetMs: number;
  /** ms until the next phase begins. Null when nothing follows (idle). */
  nextInMs: number | null;
  /** Video length this timeline was computed with (resolved or nominal). */
  videoMs: number;
}

const IDLE: BriefingTimeline = { phase: "idle", videoOffsetMs: 0, nextInMs: null, videoMs: 0 };

/**
 * How long a room whose group nobody moved on stays claimed.
 *
 * Only reached when staff never pressed send-to-holding, Undo, or a replacing
 * send — so it is measuring a mistake, and its job is to make that mistake
 * expire quietly overnight rather than to pace the evening. Long enough that no
 * real briefing-to-seats gap trips it, short enough that it cannot survive to
 * the next shift.
 */
const ROOM_ABANDONED_MS = 90 * 60_000;

/**
 * What a room should be showing at `nowMs`.
 *
 * Absent state is idle — the helmet poster — which is also what a room shows
 * before the first send of the day and after the last one expires. Idle is a
 * designed state, not a fallback: a briefing room with nothing queued should be
 * showing sizing information to whoever wanders in.
 */
export function briefingTimelineAt(
  state: BriefingRoomState | null | undefined,
  nowMs: number,
): BriefingTimeline {
  if (!state) return IDLE;

  const startedAtMs = state.triggeredAtMs;
  if (!Number.isFinite(startedAtMs)) return IDLE;

  // A send stamped in the future means the writer's clock is ahead of ours.
  // Treat it as "just now" rather than sitting on idle until the skew passes —
  // a room with a group standing in it must play the video.
  const elapsed = Math.max(0, nowMs - startedAtMs);

  // ASSIGNED: sent, not started. Holds until staff press Start — deliberately no
  // auto-advance, because the whole point is that a person decides when the room
  // is actually ready. It does time out, so a session nobody started cannot sit
  // on the wall all evening.
  if (state.kind === "assigned") {
    return elapsed < ASSIGNED_HOLD_MS
      ? { phase: "waiting", videoOffsetMs: 0, nextInMs: null, videoMs: 0 }
      : IDLE;
  }

  // No video URL ⇒ nothing to play, so the timeline starts at the helmet board.
  // This is the honest behaviour for "staff sent a briefing before anybody
  // uploaded the film": show sizing and the qualifiers, never a black screen.
  const videoMs = state.videoUrl
    ? Number.isFinite(state.videoDurationMs) && (state.videoDurationMs as number) > 0
      ? (state.videoDurationMs as number)
      : NOMINAL_VIDEO_MS
    : 0;

  if (elapsed < videoMs) {
    return {
      phase: "video",
      videoOffsetMs: elapsed,
      nextInMs: videoMs - elapsed,
      videoMs,
    };
  }

  /**
   * HELMETS ARE WHERE THE TIMELINE STOPS, AND IT WAITS THERE (owner 2026-08-14:
   * "don't auto complete that section… there shouldn't be any auto moving to
   * holding. I think when briefing done it does some 30 second helmet countdown
   * then goes to limbo").
   *
   * It used to run out after 30 seconds and fall to IDLE, on the rule that "once
   * the helmet portion is done this should clear and be ready for the next"
   * (owner 2026-08-11). That rule was written before the holding step existed,
   * and the holding step is what makes it wrong: a room now empties when staff
   * SEND the group to the seats, not when a countdown finishes.
   *
   * The cost was exactly the limbo described. Thirty seconds after the film the
   * desk's box went idle, which took the "Send to holding" control down with it —
   * so the group was still standing in the room with no way left to move them
   * on, and the board had quietly declared the room free for the next heat.
   *
   * So the helmet phase has no end: the film is over, they are getting kitted,
   * and they stay the room's occupants until a human says otherwise. `nextInMs`
   * is null because nothing follows on a clock — the next thing is a press.
   * Every path out of here is now deliberate: send to holding, Undo, or a
   * replacing send. The Redis TTL below is the only backstop, and it is a
   * backstop rather than a schedule.
   */
  if (elapsed >= videoMs) {
    return { phase: "helmet", videoOffsetMs: 0, nextInMs: null, videoMs };
  }

  return IDLE;
}

/**
 * MAY THIS ROOM'S GROUP BE SENT TO THE SEATS YET? PURE — a timeline in, a
 * verdict out.
 *
 * The tablet let staff press Send to holding at any point in the briefing,
 * including with the safety film still running (owner 2026-08-15: "Briefing
 * tablets are allowing to send to holding before video is done"). The film is
 * not a formality — it is the safety briefing every racer is required to have
 * seen — so walking a group out mid-video means nobody in that group got it.
 *
 * A REASON CODE, NOT A SENTENCE, because the clock belongs to whoever is
 * drawing it: the tablet prints the time left beside the words, and a server
 * refusal has no clock to print. Same split the rest of this module keeps —
 * arithmetic here, formatting at the edge.
 *
 * `helmet` is the yes: the film has run to the end and they are getting kitted.
 * A room with NO video at all lands there immediately (videoMs is 0), so a
 * briefing sent before anyone uploaded a film is not blocked by a film that
 * does not exist.
 *
 * `idle` is also a yes, deliberately. It means the assignment timed out, and
 * the group may well still be standing in the room — refusing there would
 * strand them with no way off the board at all, which is the limbo the helmet
 * phase was rewritten to kill.
 */
export type HoldingReadiness =
  | { ok: true }
  | { ok: false; reason: "video-playing" | "not-started" };

export function briefingReadyForHolding(timeline: BriefingTimeline): HoldingReadiness {
  if (timeline.phase === "video") return { ok: false, reason: "video-playing" };
  if (timeline.phase === "waiting") return { ok: false, reason: "not-started" };
  return { ok: true };
}

/**
 * How long a room's Redis key should live, so the state outlives the whole
 * timeline and not a second longer.
 *
 * Tying the TTL to the timeline rather than picking a round number is what stops
 * two failure modes at once: a key expiring mid-video (the wall drops to the
 * helmet board while a group is still watching), and last night's send still
 * sitting in Redis this morning.
 */
export function briefingStateTtlSeconds(state: BriefingRoomState): number {
  // An assignment waits on a human, so its key must outlive the hold window
  // rather than any video length.
  if (state.kind === "assigned") return Math.ceil((ASSIGNED_HOLD_MS + 60_000) / 1000);
  const videoMs =
    Number.isFinite(state.videoDurationMs) && (state.videoDurationMs as number) > 0
      ? (state.videoDurationMs as number)
      : NOMINAL_VIDEO_MS;
  /**
   * A BACKSTOP, NOT A SCHEDULE — which is the whole difference from what this
   * used to be. The helmet phase no longer ends on a clock (see above), so a TTL
   * of video + 30s + a minute would now expire the key while the group is still
   * in the room and hand the desk the same limbo by another route.
   *
   * The real ends are the presses: send to holding, Undo, or a replacing send.
   * This only catches a room nobody closed at all, and it is deliberately longer
   * than any plausible briefing-to-seats gap and shorter than a shift, so a
   * forgotten room frees itself tonight rather than greeting the morning crew.
   */
  return Math.ceil((videoMs + HELMET_PHASE_MS + ROOM_ABANDONED_MS) / 1000);
}
