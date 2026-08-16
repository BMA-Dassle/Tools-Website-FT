/**
 * IS THE TIMING FEED ALIVE? — the one question nothing could answer.
 *
 * The kart-timing-bridge (Railway) holds the WebSocket to the venue's timing
 * server and POSTs every changed record to our webhook, which stamps
 * `kart:bridge:last-event` on each accepted message. That heartbeat has existed
 * since the bridge shipped and NOTHING read it: on 2026-08-15 the feed went
 * silent mid-session and the only symptom anyone had was the race clocks quietly
 * being wrong, then a manual Railway reboot. The signal was there; no screen
 * carried it.
 *
 * So the desk gets it. This is deliberately a READ of a stamp somebody else
 * writes — no probing, no side effects, no second source of truth.
 *
 * WHAT THE AGE ACTUALLY MEANS. The heartbeat moves on every FORWARDED message,
 * not every frame. The bridge dedupes (`changedOnly`) because the venue resends
 * its entire snapshot once a second, so a genuinely quiet venue produces few
 * forwards — the age is "when did something last CHANGE", not "when did we last
 * hear anything". That is why `stale` is a wide amber band rather than an alarm:
 * during racing the feed is continuous, and between sessions a minute or two of
 * nothing is normal, not broken.
 */
import redis from "@/lib/redis";

/** Written by app/api/webhooks/kart-timing-event on every accepted message. */
const HEARTBEAT_KEY = "kart:bridge:last-event";

/**
 * Under this, the feed is unambiguously live. Measured 2026-08-15 during a full
 * evening: forwards ran ~110/min while racing and the widest silence across a
 * 45-minute window was under a minute.
 */
const LIVE_MAX_AGE_MS = 90_000;
/**
 * Past this, something is wrong rather than quiet. The webhook sets a 1h TTL on
 * the key, so a feed down longer than that reads as `down` via a missing key
 * instead — both land in the same red state.
 */
const STALE_MAX_AGE_MS = 5 * 60_000;

export type TimingFeedState = "live" | "stale" | "down" | "unknown";

export interface TimingFeedStatus {
  state: TimingFeedState;
  /** When the last message was accepted, epoch ms. Null when we cannot say. */
  lastEventMs: number | null;
  /** Age at the moment this was read, so a board can render without re-deriving
   *  against a device clock that may be wrong. */
  ageMs: number | null;
}

/**
 * Never throws. A board that cannot reach Redis must show "unknown" — an honest
 * "we don't know" — and must NOT show a red DOWN, which would send staff
 * chasing a feed that is probably fine.
 */
export async function readTimingFeedStatus(nowMs = Date.now()): Promise<TimingFeedStatus> {
  let raw: string | null = null;
  try {
    raw = await redis.get(HEARTBEAT_KEY);
  } catch {
    return { state: "unknown", lastEventMs: null, ageMs: null };
  }

  // No key at all: either the bridge has never run, or it has been silent long
  // enough for the webhook's 1h TTL to expire it. Both are down.
  if (!raw) return { state: "down", lastEventMs: null, ageMs: null };

  const lastEventMs = Date.parse(raw);
  if (!Number.isFinite(lastEventMs)) {
    return { state: "unknown", lastEventMs: null, ageMs: null };
  }

  // Clamp at zero: a small negative age is clock skew between the webhook's
  // lambda and this one, not the future.
  const ageMs = Math.max(0, nowMs - lastEventMs);
  const state: TimingFeedState =
    ageMs <= LIVE_MAX_AGE_MS ? "live" : ageMs <= STALE_MAX_AGE_MS ? "stale" : "down";
  return { state, lastEventMs, ageMs };
}
