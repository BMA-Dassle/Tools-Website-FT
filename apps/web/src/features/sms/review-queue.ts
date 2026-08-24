import redis from "@/lib/redis";
import type { InboundClassification } from "./inbound-keywords";

/**
 * Queue of inbound messages the keyword matcher would not auto-action.
 *
 * ── This queue is a compliance control, not a nicety ────────────────
 *
 * The classifier deliberately refuses to auto-action a sentence-embedded
 * opt-out, because no regex separates T-Mobile's "Stop it!" (must opt
 * out) from "I cannot get my device to stop, can you help?" (must not).
 * That is the right call technically, but it converts a code problem into
 * an operational one: the revocation is only honored if a human sees this
 * queue and acts.
 *
 * `64.1200(a)(11)` treats any reasonable expression as a revocation,
 * CTIA SCMH § 3.8.2 requires scanning logs for opt-out attempts
 * "regardless of whether the subscribers used the correct opt-out
 * keywords", and Fla. Stat. § 501.059(10)(c) starts a 15-day clock on a
 * missed one. An unworked queue fails all three while looking like a
 * feature.
 *
 * Hence: `priority: "high"` items are counted separately and the oldest
 * unresolved one is tracked, so "nobody has looked at this in four days"
 * is a number someone can alert on rather than a discovery made in
 * deposition.
 *
 * Redis, not Postgres, and that is a deliberate difference from the
 * consent ledger: this is a WORK queue, not evidence. The evidence is the
 * `sms_consent_events` row written when a human acts. Nothing here needs
 * to survive five years — but a long TTL anyway, because "we never got
 * round to it" should stay visible.
 */

const QUEUE = "sms:inbound:review";
const QUEUE_MAX = 500;
const QUEUE_TTL = 60 * 60 * 24 * 90;

export interface ReviewItem {
  /** Vox message id — also the dedupe key against retried callbacks. */
  id: string;
  receivedAt: string;
  phoneE164: string;
  body: string;
  action: InboundClassification["action"];
  reviewReason?: InboundClassification["reviewReason"];
  priority: "high" | "normal";
  matched: string | null;
}

/**
 * Add a message for human review.
 *
 * Idempotent on the Vox message id: a retried callback must not create a
 * second copy of the same guest message, or the queue's own counts stop
 * meaning anything.
 */
export async function enqueueForReview(item: ReviewItem): Promise<{ added: boolean }> {
  try {
    // SET NX as the dedupe latch. Cheaper than scanning the list, and it
    // survives the list being trimmed.
    const latch = await redis.set(`sms:inbound:seen:${item.id}`, "1", "EX", QUEUE_TTL, "NX");
    if (latch === null) return { added: false };

    const tx = redis.multi();
    tx.lpush(QUEUE, JSON.stringify(item));
    tx.ltrim(QUEUE, 0, QUEUE_MAX - 1);
    tx.expire(QUEUE, QUEUE_TTL);
    if (item.priority === "high") {
      tx.incr("sms:inbound:review:high");
      tx.expire("sms:inbound:review:high", QUEUE_TTL);
      // First high-priority item since the last clear sets the clock. A
      // staffer needs "oldest unactioned revocation signal", not a count.
      tx.set("sms:inbound:review:oldestHigh", item.receivedAt, "EX", QUEUE_TTL, "NX");
    }
    await tx.exec();
    return { added: true };
  } catch (err) {
    // Never throw at the webhook. A failed enqueue must not turn into a
    // non-2xx, because Vox would retry and we would risk double-acting on
    // the auto-handled cases.
    console.error("[sms-review-queue] enqueue failed:", err);
    return { added: false };
  }
}

export interface ReviewQueueSnapshot {
  depth: number;
  highPriority: number;
  oldestHighAt: string | null;
  items: ReviewItem[];
}

/** Read the queue for the admin surface. */
export async function readReviewQueue(limit = 50): Promise<ReviewQueueSnapshot> {
  try {
    const [raw, high, oldest, depth] = await Promise.all([
      redis.lrange(QUEUE, 0, limit - 1),
      redis.get("sms:inbound:review:high"),
      redis.get("sms:inbound:review:oldestHigh"),
      redis.llen(QUEUE),
    ]);
    const items: ReviewItem[] = [];
    for (const r of raw) {
      try {
        items.push(JSON.parse(r) as ReviewItem);
      } catch {
        /* skip a corrupt entry rather than failing the whole read */
      }
    }
    return {
      depth,
      highPriority: high ? parseInt(high, 10) : 0,
      oldestHighAt: oldest || null,
      items,
    };
  } catch (err) {
    console.error("[sms-review-queue] read failed:", err);
    return { depth: 0, highPriority: 0, oldestHighAt: null, items: [] };
  }
}
