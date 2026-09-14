import "server-only";

/**
 * THE STAFF "READY TO PULL" MARK — the third trigger in ready-to-pull.ts.
 *
 * A person at the desk says the called group is ready for the briefing room
 * before the roster or the clock would say so (owner 2026-09-13: "someone
 * presses [the] button… to start indicating ready to pull"). The press writes
 * this; every wall's CHECKING IN row reads it and flashes.
 *
 * KEYED BY TRACK, HOLDING THE SESSION. One track has one called heat at a time,
 * so the mark lives under the track and names the session it was pressed for.
 * Two properties fall out of that, both load-bearing:
 *
 *   • ONE MGET SERVES EVERY READER. The TV pulse runs every two seconds on every
 *     wall and the desk pulse every two seconds on every station; three keys in
 *     one round trip is a cost that does not grow with the night.
 *   • A STALE MARK CANNOT LIGHT THE NEXT HEAT. Readers compare the stored
 *     `sessionId` with the heat they are drawing, so a mark pressed for Session
 *     41 does nothing once Session 42 is called on that track — even before the
 *     TTL clears it.
 *
 * NEVER THROWS ON READ. A Redis blip costs the flash, not the wall.
 */
import redis from "@/lib/redis";
import type { TrackKey } from "../track";

const VENUE = "FT";
const TRACKS: readonly TrackKey[] = ["blue", "red", "mega"] as const;

/** Long enough to outlive any real check-in; short enough never to greet
 *  tomorrow's first heat on the same track. The session match above is the
 *  real guard — this only keeps Redis tidy. */
const TTL_SECONDS = 2 * 3600;

function key(track: TrackKey): string {
  return `briefing:ready-to-pull:${VENUE}:${track}`;
}

export interface ReadyToPullMark {
  /** STRING — a Pandora session id never passes through Number() (house rule). */
  sessionId: string;
  atMs: number;
}

export type ReadyToPullByTrack = Record<TrackKey, ReadyToPullMark | null>;

const EMPTY: ReadyToPullByTrack = { blue: null, red: null, mega: null };

/** A plain SET — pressing again for the same session simply refreshes the stamp. */
export async function markReadyToPull(
  track: TrackKey,
  sessionId: string,
): Promise<ReadyToPullMark> {
  const mark: ReadyToPullMark = { sessionId, atMs: Date.now() };
  await redis.set(key(track), JSON.stringify(mark), "EX", TTL_SECONDS);
  return mark;
}

/** The press undone — the walls stop flashing on the next beat. */
export async function clearReadyToPull(track: TrackKey): Promise<void> {
  await redis.del(key(track));
}

/** Every track's mark in one MGET. Empty on any failure. */
export async function readReadyToPull(): Promise<ReadyToPullByTrack> {
  try {
    const raws = await redis.mget(...TRACKS.map(key));
    const out: ReadyToPullByTrack = { ...EMPTY };
    TRACKS.forEach((track, i) => {
      const raw = raws[i];
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Partial<ReadyToPullMark>;
        if (typeof parsed.sessionId === "string" && parsed.sessionId) {
          out[track] = { sessionId: parsed.sessionId, atMs: Number(parsed.atMs) || 0 };
        }
      } catch {
        /* one unreadable mark must not lose the other tracks */
      }
    });
    return out;
  } catch {
    return { ...EMPTY };
  }
}
