import "server-only";

/**
 * The pit cue stamps' READ side, on its own so both directions can use it:
 * audio.server.ts (which also WRITES stamps and imports lane.server) and
 * lane.server.ts (which derives "post played = returned" at resolve time —
 * owner 2026-08-14: "when it is in that hold state, check to see if post was
 * played, it seems like it can get stuck"). Living inside audio.server.ts
 * this would be an import cycle: audio → lane → audio.
 */
import redis from "@/lib/redis";

export type PitCue = "pre" | "post";

/** One played cue: when, and the clip length when the player said in time. */
export interface CueStamp {
  atMs: number;
  durationS: number | null;
}

export function cueKey(cue: PitCue, sessionId: string): string {
  return `pit:audio:${cue}:${sessionId}`;
}

/** Stamps started life as a bare epoch-ms string and grew a duration field
 *  the day the Pandora endpoints landed — both shapes stay readable for the
 *  12h a pre-upgrade stamp can still be live. */
export function parseStamp(raw: string | null): CueStamp | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return { atMs: n, durationS: null };
  try {
    const p = JSON.parse(raw) as { atMs?: number; durationS?: number | null };
    if (typeof p.atMs !== "number" || !Number.isFinite(p.atMs)) return null;
    return {
      atMs: p.atMs,
      durationS:
        typeof p.durationS === "number" && Number.isFinite(p.durationS) ? p.durationS : null,
    };
  } catch {
    return null;
  }
}

/** When (and how long) a cue played for a session, or null. Swallows —
 *  reads ride the feed. */
export async function readCueStamp(cue: PitCue, sessionId: string): Promise<CueStamp | null> {
  if (!sessionId) return null;
  try {
    return parseStamp(await redis.get(cueKey(cue, sessionId)));
  } catch {
    return null;
  }
}

/** Both cues for one session — what the control board's GET carries. */
export interface PitCueStamps {
  pre: CueStamp | null;
  post: CueStamp | null;
}

export async function readCueStamps(sessionId: string): Promise<PitCueStamps> {
  const [pre, post] = await Promise.all([
    readCueStamp("pre", sessionId),
    readCueStamp("post", sessionId),
  ]);
  return { pre, post };
}
