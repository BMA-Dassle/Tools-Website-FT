import "server-only";

/**
 * THE HANDSHAKE BETWEEN TWO PRESSES — Redis-coordinated, because the two
 * presses may come from two tablets and land on two serverless instances.
 * The RULE (why, how long, which zone) is cue-sync.ts; this is only the
 * plumbing, and audio.server.ts is the one caller.
 *
 * Roles. The first press to claim the LEAD holds the window and, if the
 * other track's press arrives, plays for both. The second press is the
 * JOINER: it announces itself (so the leader sees it) and waits for the
 * leader to publish its outcome, which it then returns as its own — the
 * tablet that pressed second gets the same "playing on both" receipt.
 *
 * Every key is per CUE, so a pre being synced never blocks a post.
 *
 *   pit:audio:sync:{cue}:lead            which track holds the window
 *   pit:audio:sync:{cue}:intent:{track}  "I have pressed" — session it is for
 *   pit:audio:sync:{cue}:result:{track}  the leader's outcome for that track
 *
 * TTLs are short and generous relative to the window: nothing here outlives a
 * press that died mid-flight by more than a few seconds, and a stale result
 * cannot be mistaken for a fresh one because the joiner checks the session it
 * names. Every Redis failure degrades to "no sync" — the press plays solo, as
 * it did before this existed.
 */
import redis from "@/lib/redis";
import type { TrackKey } from "../track";
import { CUE_SYNC_POLL_MS } from "./cue-sync";
import type { PitCue } from "./audio-stamps.server";
import type { PlayCueResult } from "./audio.server";

const LEAD_TTL_S = 20;
const INTENT_TTL_S = 20;
const RESULT_TTL_S = 30;

const leadKey = (cue: PitCue) => `pit:audio:sync:${cue}:lead`;
const intentKey = (cue: PitCue, track: TrackKey) => `pit:audio:sync:${cue}:intent:${track}`;
const resultKey = (cue: PitCue, track: TrackKey) => `pit:audio:sync:${cue}:result:${track}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SyncLead =
  /** This press holds the window. */
  | { role: "lead" }
  /** Another press holds it — the track named is waiting for a partner. */
  | { role: "follow"; leader: TrackKey }
  /** Redis could not be asked — behave as if no sync exists. */
  | { role: "unavailable" };

export async function claimSyncLead(cue: PitCue, track: TrackKey): Promise<SyncLead> {
  try {
    const claimed = await redis.set(leadKey(cue), track, "EX", LEAD_TTL_S, "NX");
    if (claimed === "OK") return { role: "lead" };
    const holder = await redis.get(leadKey(cue));
    if (holder === "blue" || holder === "red" || holder === "mega") {
      return { role: "follow", leader: holder };
    }
    // The lead lapsed between our SET and GET — take it.
    const again = await redis.set(leadKey(cue), track, "EX", LEAD_TTL_S, "NX");
    return again === "OK" ? { role: "lead" } : { role: "unavailable" };
  } catch {
    return { role: "unavailable" };
  }
}

export async function releaseSyncLead(cue: PitCue): Promise<void> {
  await redis.del(leadKey(cue)).catch(() => void 0);
}

export async function announceSyncIntent(
  cue: PitCue,
  track: TrackKey,
  sessionId: string,
): Promise<void> {
  await redis
    .set(intentKey(cue, track), JSON.stringify({ sessionId, atMs: Date.now() }), "EX", INTENT_TTL_S)
    .catch(() => void 0);
}

export async function clearSyncIntents(cue: PitCue, tracks: TrackKey[]): Promise<void> {
  await Promise.all(tracks.map((t) => redis.del(intentKey(cue, t)).catch(() => void 0)));
}

/**
 * The leader's wait: poll for the partner's intent until the window closes.
 * Returns the session the partner pressed for, or null when nobody came.
 */
export async function waitForSyncIntent(
  cue: PitCue,
  partner: TrackKey,
  windowMs: number,
  pollMs: number = CUE_SYNC_POLL_MS,
): Promise<{ sessionId: string } | null> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    try {
      const raw = await redis.get(intentKey(cue, partner));
      if (raw) {
        const parsed = JSON.parse(raw) as { sessionId?: string };
        if (typeof parsed.sessionId === "string" && parsed.sessionId) {
          return { sessionId: parsed.sessionId };
        }
      }
    } catch {
      /* a failed poll is just a missed beat */
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** What the leader tells each track's press about its own cue. */
export type SyncResult = PlayCueResult & { sessionId: string };

export async function publishSyncResult(
  cue: PitCue,
  track: TrackKey,
  result: SyncResult,
): Promise<void> {
  await redis
    .set(resultKey(cue, track), JSON.stringify(result), "EX", RESULT_TTL_S)
    .catch(() => void 0);
}

/**
 * The joiner's wait: poll for the leader's published outcome FOR THIS
 * SESSION. A result naming another session is a stale one from an earlier
 * cycle and is ignored. The result is consumed (deleted) on read so a repeat
 * press cannot replay it.
 */
export async function waitForSyncResult(
  cue: PitCue,
  track: TrackKey,
  sessionId: string,
  timeoutMs: number,
  pollMs: number = CUE_SYNC_POLL_MS,
): Promise<PlayCueResult | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await redis.get(resultKey(cue, track));
      if (raw) {
        const parsed = JSON.parse(raw) as SyncResult;
        if (parsed.sessionId === sessionId) {
          await redis.del(resultKey(cue, track)).catch(() => void 0);
          return parsed;
        }
      }
    } catch {
      /* a failed poll is just a missed beat */
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
