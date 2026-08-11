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

/* ── remote reload ────────────────────────────────────────────────────── */

const RELOAD_TTL_SECONDS = 24 * 3600;

function reloadKey(center: string): string {
  return `signage:reload:${center}`;
}

/**
 * Ask every screen in a center to reload.
 *
 * Screens self-update on a timer, but that is a poll — during a run of rapid
 * deploys, or when a board is visibly wrong in front of guests, "within a few
 * minutes" is not good enough and walking to each player PC is worse. This is
 * the button that fixes a wall from a phone.
 *
 * Stored as a timestamp rather than a queued message so it is idempotent: a
 * screen reloads when it sees a stamp NEWER than its own boot, and pressing the
 * button twice cannot cause two reloads.
 */
export async function requestScreenReload(center: string): Promise<void> {
  try {
    await redis.set(reloadKey(center), String(Date.now()), "EX", RELOAD_TTL_SECONDS);
  } catch {
    /* the timer-based self-update is the backstop */
  }
}

/** When a reload was last requested for this center, or null. */
export async function reloadRequestedAt(center: string): Promise<number | null> {
  try {
    const raw = await redis.get(reloadKey(center));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/* ── pushed preview ───────────────────────────────────────────────────── */

/**
 * How long a pushed preview lasts. Deliberately short and enforced by the Redis
 * TTL rather than by anything remembering to clear it: a screen showing
 * fabricated guests cannot be left that way by a distracted staff member, a
 * closed laptop, or a crash. It expires on its own.
 */
const DEMO_TTL_SECONDS = 90;

function demoKey(screenId: string): string {
  return `signage:demo:${screenId}`;
}

/** Put one screen into a preview mode, on the wall, for DEMO_TTL_SECONDS. */
export async function requestScreenDemo(screenId: string, mode: string): Promise<void> {
  try {
    await redis.set(demoKey(screenId), mode, "EX", DEMO_TTL_SECONDS);
  } catch {
    /* preview is a convenience — never worth surfacing an error for */
  }
}

/** Clear a preview early. */
export async function clearScreenDemo(screenId: string): Promise<void> {
  try {
    await redis.del(demoKey(screenId));
  } catch {
    /* it expires on its own regardless */
  }
}

/** The preview a screen should currently be showing, if any. */
export async function demoRequestedFor(screenId: string): Promise<string | null> {
  try {
    return await redis.get(demoKey(screenId));
  } catch {
    return null;
  }
}
