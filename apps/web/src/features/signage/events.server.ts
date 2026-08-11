import "server-only";

/**
 * The live event rail: "something just happened on a device in this building."
 *
 * A short, capped, expiring Redis list per center. TVs read it on their poll and
 * celebrate the newest thing they have not already shown.
 *
 * WHY A LIST AND NOT PUB/SUB: this app has no pub/sub and no SSE, and adding a
 * realtime tier to make a confetti burst 8 seconds earlier is a bad trade — a
 * capped LPUSH + LRANGE costs nothing and cannot back up. See the platform notes.
 *
 * THIS MUST NEVER THROW. It is called from inside booking and check-in
 * completion paths. A Redis blip is allowed to cost a confetti animation; it is
 * never allowed to touch a guest's transaction. Every export swallows.
 *
 * NOT A RECORD. Nothing here is durable or authoritative — the real truth is
 * already in Neon and BMI. This is a display cue with a one-hour life.
 */
import redis from "@/lib/redis";
import type { SignageEvent } from "./types";

const MAX_EVENTS = 20;
const TTL_SECONDS = 3600;

export function signageEventsKey(center: string): string {
  return `signage:events:${center}`;
}

/**
 * Publish an event for the TVs in a center.
 *
 * Fire-and-forget from the caller's perspective: await it if convenient, ignore
 * it if not. It resolves either way.
 */
export async function recordSignageEvent(event: SignageEvent): Promise<void> {
  try {
    const key = signageEventsKey(event.center);
    await redis
      .multi()
      .lpush(key, JSON.stringify(event))
      .ltrim(key, 0, MAX_EVENTS - 1)
      .expire(key, TTL_SECONDS)
      .exec();
  } catch {
    /* display cue only — never surface to a caller on the money path */
  }
}

/** Newest-first. Malformed entries are skipped, never thrown on. */
export async function readSignageEvents(center: string): Promise<SignageEvent[]> {
  try {
    const raw = await redis.lrange(signageEventsKey(center), 0, MAX_EVENTS - 1);
    const out: SignageEvent[] = [];
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line) as SignageEvent;
        if (parsed && typeof parsed.id === "string" && typeof parsed.atMs === "number") {
          out.push(parsed);
        }
      } catch {
        /* one bad row must not blank the rail */
      }
    }
    return out;
  } catch {
    return [];
  }
}
