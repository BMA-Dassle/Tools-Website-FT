/**
 * Parsing a stored briefing-room state. PURE — no Redis, so it is testable.
 *
 * SPLIT OUT OF state.server.ts BECAUSE OF A REAL BUG (2026-08-11). `assigned` was
 * added to BriefingRoomState and to the writer, but not to the guard that reads it
 * back. Every send was stored, immediately re-read as unparseable, and the room
 * reported "Empty" — so pressing Send looked like it did nothing, while the durable
 * assignment row and the success toast both insisted it had worked.
 *
 * tsc could not catch it: the guard narrows a `string` off parsed JSON, so dropping
 * a member of the union is invisible. The fix is to make the set of kinds DATA
 * (BRIEFING_ROOM_KINDS) and iterate it in a test, so adding a kind without teaching
 * the parser fails a test rather than a briefing room full of people.
 *
 * VALIDATION POSTURE — strict, deliberately the opposite of screen config. A
 * partially-understood screen config still paints something reasonable, so it is
 * honoured. A partially-understood briefing state could play the wrong safety film
 * to a room, so anything we cannot fully read becomes the designed idle board.
 * Fields that only affect presentation (track, tier) are normalised rather than
 * failing the whole state.
 */
import type { BriefingRoomState } from "./types";

/** Every kind a stored state may carry. Keep in step with BriefingRoomState.kind —
 *  state-parse.test.ts iterates this, so a missing entry fails loudly. */
export const BRIEFING_ROOM_KINDS = ["assigned", "timeline", "quals-only"] as const;

function isKind(raw: unknown): raw is BriefingRoomState["kind"] {
  return typeof raw === "string" && (BRIEFING_ROOM_KINDS as readonly string[]).includes(raw);
}

/** Parse a stored state, or null if it cannot be trusted. Never throws. */
export function parseBriefingRoomState(raw: string | null): BriefingRoomState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<BriefingRoomState>;
    if (!isKind(p.kind)) return null;
    // The clock is the one field the whole timeline is derived from; without a
    // usable one there is nothing to show.
    if (typeof p.triggeredAtMs !== "number" || !Number.isFinite(p.triggeredAtMs)) return null;
    return {
      kind: p.kind,
      tier: p.tier === "starter" || p.tier === "intermediate" ? p.tier : null,
      track: p.track === "blue" || p.track === "red" || p.track === "mega" ? p.track : "mega",
      raceType: typeof p.raceType === "string" && p.raceType ? p.raceType : null,
      sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
      heatNumber: typeof p.heatNumber === "number" ? p.heatNumber : null,
      triggeredAtMs: p.triggeredAtMs,
      videoUrl: typeof p.videoUrl === "string" && p.videoUrl ? p.videoUrl : null,
      videoDurationMs:
        typeof p.videoDurationMs === "number" && Number.isFinite(p.videoDurationMs)
          ? p.videoDurationMs
          : null,
    };
  } catch {
    return null;
  }
}
