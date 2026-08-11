/**
 * The briefing timeline. PURE — no React, no clock reads, no I/O.
 *
 * One send writes a start time. Everything after that is arithmetic:
 *
 *     0 ─────────── video ──────────► d ── helmet ──► d+30s ─── quals ───► +30m ─► idle
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
  HELMET_PHASE_MS,
  NOMINAL_VIDEO_MS,
  QUALS_PHASE_MS,
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

  if (state.kind === "quals-only") {
    return elapsed < QUALS_PHASE_MS
      ? { phase: "quals", videoOffsetMs: 0, nextInMs: QUALS_PHASE_MS - elapsed, videoMs: 0 }
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

  const helmetEnd = videoMs + HELMET_PHASE_MS;
  if (elapsed < helmetEnd) {
    return { phase: "helmet", videoOffsetMs: 0, nextInMs: helmetEnd - elapsed, videoMs };
  }

  const qualsEnd = helmetEnd + QUALS_PHASE_MS;
  if (elapsed < qualsEnd) {
    return { phase: "quals", videoOffsetMs: 0, nextInMs: qualsEnd - elapsed, videoMs };
  }

  return IDLE;
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
  if (state.kind === "quals-only") return Math.ceil(QUALS_PHASE_MS / 1000);
  const videoMs =
    Number.isFinite(state.videoDurationMs) && (state.videoDurationMs as number) > 0
      ? (state.videoDurationMs as number)
      : NOMINAL_VIDEO_MS;
  // One extra minute of headroom: a TV polling every 2s must never be the thing
  // that discovers the key vanished a beat before the board was due to change.
  return Math.ceil((videoMs + HELMET_PHASE_MS + QUALS_PHASE_MS + 60_000) / 1000);
}
