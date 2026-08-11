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

export async function markSessionBriefed(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await redis.set(briefedKey(sessionId), String(Date.now()), "EX", BRIEFED_TTL_SECONDS);
  } catch {
    /* the board keeps showing the heat — no worse than before this existed */
  }
}

/** When this session was sent to a room, or null. */
export async function sessionBriefedAt(sessionId: string | null): Promise<number | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(briefedKey(sessionId));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
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
