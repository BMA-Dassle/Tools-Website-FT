import "server-only";

/**
 * Briefing-room display state — the Redis rail one staff press writes.
 *
 * Same shape and same discipline as events.server.ts: a short-lived key per
 * room, read by the TV on its 2-second pulse, and EVERY EXPORT SWALLOWS. A Redis
 * blip is allowed to cost a briefing animation; it is never allowed to throw
 * back into a staff action that has already written its durable row.
 *
 * NOT A RECORD. The durable truth is `briefing_assignments` in Neon. This key is
 * "what is on the wall in RED right now", and it expires on its own so a send
 * cannot be left on a screen overnight by a distracted staff member or a crash.
 */
import redis from "@/lib/redis";
import { briefingStateTtlSeconds } from "./phase";
import { BRIEFING_ROOMS, type BriefingRoom, type BriefingRoomState } from "./types";

function roomKey(venue: string, room: BriefingRoom): string {
  return `briefing:room:${venue}:${room}`;
}

/** Put a room into a state. TTL is derived from the timeline — see phase.ts. */
export async function setBriefingRoom(
  venue: string,
  room: BriefingRoom,
  state: BriefingRoomState,
): Promise<void> {
  try {
    await redis.set(
      roomKey(venue, room),
      JSON.stringify(state),
      "EX",
      briefingStateTtlSeconds(state),
    );
  } catch {
    /* the durable assignment row is already written — see the header */
  }
}

/** Clear a room ("room done"). */
export async function clearBriefingRoom(venue: string, room: BriefingRoom): Promise<void> {
  try {
    await redis.del(roomKey(venue, room));
  } catch {
    /* it expires on its own regardless */
  }
}

/** One room's state, or null when idle. Malformed JSON reads as idle, never
 *  throws — a corrupt key must not take a wall down. */
export async function readBriefingRoom(
  venue: string,
  room: BriefingRoom,
): Promise<BriefingRoomState | null> {
  try {
    const raw = await redis.get(roomKey(venue, room));
    return parseState(raw);
  } catch {
    return null;
  }
}

/** Both rooms in ONE round-trip — this runs on the 2-second pulse, so it is a
 *  single MGET rather than a read per room. */
export async function readBriefingRooms(
  venue: string,
): Promise<Record<BriefingRoom, BriefingRoomState | null>> {
  const empty = { red: null, blue: null } as Record<BriefingRoom, BriefingRoomState | null>;
  try {
    const keys = BRIEFING_ROOMS.map((r) => roomKey(venue, r));
    const values = await redis.mget(...keys);
    const out = { ...empty };
    BRIEFING_ROOMS.forEach((room, i) => {
      out[room] = parseState(values[i] ?? null);
    });
    return out;
  } catch {
    return empty;
  }
}

/**
 * Validate on the way IN, not on the way out.
 *
 * A state we cannot fully parse is dropped rather than partially honoured — the
 * opposite of the screen-config rule, and deliberately so. A half-understood
 * config still paints something reasonable; a half-understood briefing state
 * could mean playing the wrong safety video to a room, so the right answer is
 * the designed idle board.
 */
function parseState(raw: string | null): BriefingRoomState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<BriefingRoomState>;
    if (p.kind !== "timeline" && p.kind !== "quals-only") return null;
    if (typeof p.triggeredAtMs !== "number" || !Number.isFinite(p.triggeredAtMs)) return null;
    return {
      kind: p.kind,
      tier: p.tier === "starter" || p.tier === "intermediate" ? p.tier : null,
      track: p.track === "blue" || p.track === "red" || p.track === "mega" ? p.track : "mega",
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
