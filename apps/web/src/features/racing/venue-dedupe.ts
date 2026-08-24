/**
 * The venue broadcast delivers almost everything TWICE, and acting on the
 * second copy is pure waste.
 *
 * MEASURED on 88,172 webhook invocations spanning 2026-08-17 → 08-19:
 * 80,836 of them were singleton notifications, carrying only ~39,000 distinct
 * payloads — **2.07 deliveries per real event**. 33,117 events arrived exactly
 * twice, ~0.1s apart; the tail runs to 12 copies. Every duplicate costs a
 * webhook invocation, a Redis write and two `after()` handlers, for an event
 * already fully processed.
 *
 * ── WHY THE KEY IS A PAYLOAD HASH AND NOT `Id` ──────────────────────────────
 *
 * Every notification carries an `Id` and the obvious key is `($type, Id)`.
 * That is WRONG, and the survey caught it: on
 * `ProjectStateChangedNotification` the `Id` is the PROJECT id, not a
 * notification id, so one reservation walking through its states reuses it —
 *
 *   Id 63000000008866056  ProjectState "Payment started"  10:31:43.721
 *   Id 63000000008866056  ProjectState "Paid online"      10:31:43.831
 *   Id 63000000008866056  ProjectState "Confirmation"     10:31:43.877
 *
 * — three real transitions, one id, 156ms apart. 193 groups in the survey
 * shared an id across DIFFERENT payloads (the same notification also fans out
 * per resource, `ResourceIds:[blue]` vs `[red]`). An id-keyed dedupe would have
 * silently swallowed real booking state changes.
 *
 * Hashing the whole payload is the only key that cannot lose information: two
 * deliveries collapse ONLY when they are byte-for-byte the same event, and no
 * consumer downstream could have told them apart anyway. The cost is a sha1 of
 * ~240 bytes on the webhook's hot path, which is nothing next to the Redis
 * round trip it saves.
 *
 * ── WHY ARRAY FRAMES ARE NEVER DEDUPED ──────────────────────────────────────
 *
 * The race-list dumps (arrays of RaceFinish/RaceStart/RaceAdvice) are excluded
 * on purpose. `updateRaceClocks` is documented to require EVERY message
 * including replayed ones — a reconnect catch-up dump is precisely how a race
 * clock recovers its state after a bridge restart, and those dumps re-send
 * records verbatim. Deduping them would break clock recovery to save 2% of
 * traffic (1,873 of 88,172 frames). Not a trade worth making.
 */
import { createHash } from "node:crypto";

/**
 * How long a processed event is remembered.
 *
 * The widest first→last spread between copies of one event in the survey was
 * 110 seconds (median 110ms, p99 390ms). Ten minutes clears that by two orders
 * of magnitude while keeping the key space small — at ~39,000 events per 2.5
 * days the live set is a few hundred keys.
 *
 * A TTL that is too SHORT re-admits a duplicate (costs one wasted invocation);
 * too LONG would suppress a genuinely identical event repeated later. Neither
 * is harmful, which is why a generous middle is right.
 */
export const VENUE_DEDUPE_TTL_SECONDS = 10 * 60;

/**
 * Canonical JSON — keys sorted at every level, so a re-ordered but otherwise
 * identical payload still hashes the same. The wire is consistent about order
 * today; this makes the dedupe independent of that staying true.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * The Redis key that identifies this message, or `null` when the message must
 * never be deduped.
 *
 * Null for arrays (see the clock-recovery note above) and for anything that is
 * not a `$type`-bearing object — an unrecognised shape is passed through
 * untouched rather than collapsed on a guess.
 */
export function venueDedupeKey(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  if (Array.isArray(message)) return null;
  const rec = message as Record<string, unknown>;
  if (typeof rec["$type"] !== "string") return null;
  const hash = createHash("sha1").update(canonical(rec)).digest("hex").slice(0, 20);
  return `venue:evt:seen:${rec["$type"]}:${hash}`;
}
