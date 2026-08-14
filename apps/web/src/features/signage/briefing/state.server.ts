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
import { parseBriefingRoomState } from "./state-parse";
import {
  BRIEFING_ROOMS,
  parseBriefingRoom,
  type BriefingRoom,
  type BriefingRoomState,
} from "./types";

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
    return parseBriefingRoomState(raw);
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
      out[room] = parseBriefingRoomState(values[i] ?? null);
    });
    return out;
  } catch {
    return empty;
  }
}

/* ── "this session has been sent to a room" ───────────────────────────── */

/**
 * A per-session marker the TRACK check-in boards read.
 *
 * It exists so the check-in board clears on a real event rather than a timer
 * (owner 2026-08-11: "send to room should be what clears the check in TV as
 * well… don't clear it automatically, just do it based on sending to room"). Once
 * a group has been sent to a briefing room they have finished checking in, so the
 * board's job for that heat is done — which is a fact about the operation, not
 * about elapsed minutes.
 *
 * A marker rather than a Neon lookup because the boards poll every 15 seconds per
 * screen, and this has to be one cheap GET.
 */
const BRIEFED_TTL_SECONDS = 6 * 3600;

function briefedKey(sessionId: string): string {
  return `briefing:sent:${sessionId}`;
}

/**
 * Record that a session was sent, AND to which room.
 *
 * The room matters because the track check-in board announces it: "PROCEED TO THE
 * RED BRIEFING ROOM" (owner 2026-08-11). On a Mega day both track boards read the
 * same session, so both must name the SAME room — the one it actually went to —
 * which is only possible if the room travels with the marker.
 */
export async function markSessionBriefed(sessionId: string, room: BriefingRoom): Promise<void> {
  if (!sessionId) return;
  try {
    await redis.set(
      briefedKey(sessionId),
      JSON.stringify({ at: Date.now(), room }),
      "EX",
      BRIEFED_TTL_SECONDS,
    );
  } catch {
    /* the board keeps showing the heat — no worse than before this existed */
  }
}

/** When this session was sent, and where. Null when it has not been. */
export async function sessionBriefed(
  sessionId: string | null,
): Promise<{ atMs: number; room: BriefingRoom | null } | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(briefedKey(sessionId));
    if (!raw) return null;
    // Older markers were a bare timestamp; read both shapes so a send made by the
    // previous deploy still clears its board.
    try {
      const p = JSON.parse(raw) as { at?: number; room?: string };
      if (typeof p.at === "number" && Number.isFinite(p.at)) {
        return { atMs: p.at, room: parseBriefingRoom(p.room) };
      }
    } catch {
      /* fall through to the bare-number form */
    }
    const n = Number(raw);
    return Number.isFinite(n) ? { atMs: n, room: null } : null;
  } catch {
    return null;
  }
}

/**
 * The same answer for MANY sessions, in ONE round trip.
 *
 * The desk board asks this about every session it sent today, every 5 seconds —
 * as N separate GETs that would be N round trips to Redis on a list that grows
 * all evening. MGET makes it one, whatever the night's length.
 *
 * Sessions with no marker are simply absent from the result, so a caller can
 * treat "in the map" as "has been sent" without a second null check.
 */
export async function sessionsBriefed(
  sessionIds: string[],
): Promise<Record<string, { atMs: number; room: BriefingRoom | null }>> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const out: Record<string, { atMs: number; room: BriefingRoom | null }> = {};
  try {
    const raws = await redis.mget(...ids.map(briefedKey));
    ids.forEach((id, i) => {
      const raw = raws[i];
      if (!raw) return;
      // Both marker shapes, for the same reason sessionBriefed reads both.
      try {
        const p = JSON.parse(raw) as { at?: number; room?: string };
        if (typeof p.at === "number" && Number.isFinite(p.at)) {
          out[id] = { atMs: p.at, room: parseBriefingRoom(p.room) };
          return;
        }
      } catch {
        /* fall through to the bare-number form */
      }
      const n = Number(raw);
      if (Number.isFinite(n)) out[id] = { atMs: n, room: null };
    });
  } catch {
    // An empty map means "nothing is known to be sent", which leaves every
    // called heat on the board — the safe direction, and what the desk showed
    // before this marker existed.
  }
  return out;
}

/** Undo the marker, so an undone send puts the heat back on the check-in board. */
export async function clearSessionBriefed(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    await redis.del(briefedKey(sessionId));
  } catch {
    /* it expires on its own */
  }
}
