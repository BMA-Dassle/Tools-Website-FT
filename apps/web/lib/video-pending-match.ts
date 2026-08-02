import redis from "@/lib/redis";
import {
  processVideoEvent,
  type ProcessSource,
  type VideoEventInput,
} from "@/lib/video-event-processor";
import { logVideoDecision } from "@/lib/video-decision-log";

/**
 * Ordered new-match buffer (2026-08-02 hardening).
 *
 * WHY: identity assignment is positional — matchVideoToAssignment
 * gives each video the earliest unfilled camera-assignment, so the
 * ARRIVAL ORDER of first-sighting events decides who gets which
 * video. The cron sorts its poll batch by created_at for exactly this
 * reason (see the comment in app/api/cron/video-match/route.ts), but
 * the webhook — the primary path whenever the bridge is alive —
 * processed events inline in whatever order VT3 emitted them. VT3
 * emits when ENCODING finishes, and encode time varies per file, so
 * two videos captured in order routinely arrive reversed → each racer
 * gets the other's footage, with every admin chip green.
 *
 * HOW: events that would CREATE a match (no existing record for the
 * code) are buffered here instead of processed inline. A locked drain
 * — triggered opportunistically by later webhook calls and by every
 * cron tick (including the bridge-alive early exit) — processes
 * buffered events oldest-created_at-first once they've sat for a
 * settle window, with per-camera ordering enforced: a camera's later
 * video never processes while an earlier one is still settling.
 *
 * PATH-1 events (existing match: overlay refresh, block sync,
 * deferred notify) are order-insensitive and stay inline — this
 * buffer never sees them.
 *
 * Latency cost: ≤ settle window (default 90s) + drain cadence. VT3's
 * own sample encode takes ~4 min after dock, and notify only fires
 * once the sample is ready, so the effective added guest latency is
 * ~zero.
 *
 * Side fix: a sample-uploaded event arriving BEFORE any video-updated
 * event (no created_at) used to be unmatched-able until the cron's
 * stale-bridge poll woke up. Now it buffers (ordered by receive time)
 * and merges with the video-updated event when that lands.
 *
 * Kill switch: VIDEO_MATCH_ORDERED=false reverts the webhook to
 * inline match creation (pre-hardening behavior). Default ON.
 */

const EVENTS_KEY = "video-pending:events"; // HASH code -> BufferedPending JSON
const ORDER_KEY = "video-pending:order"; // ZSET code scored by orderMs
const DRAIN_LOCK_KEY = "video-pending:drain-lock";
const DRAIN_LOCK_TTL_S = 50;
const PENDING_TTL_S = 60 * 60 * 24; // 24h — matches the raw event queue
const MAX_ATTEMPTS = 5;

export function orderedMatchingEnabled(): boolean {
  return process.env.VIDEO_MATCH_ORDERED !== "false";
}

export function settleMs(): number {
  const raw = parseInt(process.env.VIDEO_MATCH_SETTLE_S || "90", 10);
  return (Number.isFinite(raw) && raw >= 0 ? raw : 90) * 1000;
}

export interface BufferedPending {
  event: VideoEventInput;
  firstReceivedAtMs: number;
  lastReceivedAtMs: number;
  attempts?: number;
}

/**
 * Merge a newly-arrived event onto the buffered one for the same code.
 * created_at keeps the EARLIEST defined value (it should never change;
 * earliest wins if VT3 ever disagrees with itself). Lifecycle fields
 * (status, sample/upload times, duration, overlay) take the LATEST
 * defined value. forceReady is sticky — once a sample-uploaded event
 * flagged readiness, a later status-only event must not clear it.
 */
export function mergeBufferedEvent(
  prev: VideoEventInput | undefined,
  next: VideoEventInput,
): VideoEventInput {
  if (!prev) return next;
  const pick = <T>(a: T | null | undefined, b: T | null | undefined): T | undefined =>
    (a ?? b ?? undefined) as T | undefined;
  const earliestCreated = (() => {
    if (!prev.created_at) return next.created_at;
    if (!next.created_at) return prev.created_at;
    return new Date(next.created_at).getTime() < new Date(prev.created_at).getTime()
      ? next.created_at
      : prev.created_at;
  })();
  return {
    ...prev,
    ...next,
    id: next.id || prev.id,
    created_at: earliestCreated,
    status: pick(next.status, prev.status) ?? null,
    sampleUploadTime: pick(next.sampleUploadTime, prev.sampleUploadTime) ?? null,
    uploadTime: pick(next.uploadTime, prev.uploadTime) ?? null,
    duration: pick(next.duration, prev.duration),
    thumbnailUrl: pick(next.thumbnailUrl, prev.thumbnailUrl),
    camera: pick(next.camera, prev.camera) ?? null,
    system: next.system ?? prev.system,
    firstImpressionAt: pick(next.firstImpressionAt, prev.firstImpressionAt) ?? null,
    lastImpressionAt: pick(next.lastImpressionAt, prev.lastImpressionAt) ?? null,
    hasVideoPageImpression: pick(next.hasVideoPageImpression, prev.hasVideoPageImpression),
    hasMediaCentreImpression: pick(next.hasMediaCentreImpression, prev.hasMediaCentreImpression),
    unlockTime: pick(next.unlockTime, prev.unlockTime) ?? null,
    purchaseType: pick(next.purchaseType, prev.purchaseType) ?? null,
    forceReady: prev.forceReady === true || next.forceReady === true || undefined,
  };
}

/** The camera-history key this event's match walk will use — mirrors
 *  matchVideoToAssignment's camera-first-then-system lookup. Per-
 *  camera ordering only needs to group by the same key the walk uses. */
export function pendingCameraKey(event: VideoEventInput): string {
  if (event.camera != null) return String(event.camera);
  return event.system?.name ?? "";
}

export interface DrainPlanEntry {
  code: string;
  cameraKey: string;
  /** created_at ms when known, else firstReceivedAtMs. */
  orderMs: number;
  id: number;
  firstReceivedAtMs: number;
}

/**
 * Which buffered codes are safe to process right now, in order.
 *
 * Per camera key: sort by (orderMs, id) and take the longest prefix
 * whose entries are all past the settle window — a later video on the
 * same camera never jumps an earlier one that is still settling
 * (that jump is exactly the wrong-driver swap this module exists to
 * prevent). Cameras are independent of each other; groups are
 * emitted earliest-first for determinism.
 */
export function planDrainOrder(
  entries: DrainPlanEntry[],
  nowMs: number,
  settleWindowMs: number,
): string[] {
  const byCamera = new Map<string, DrainPlanEntry[]>();
  for (const e of entries) {
    const list = byCamera.get(e.cameraKey);
    if (list) list.push(e);
    else byCamera.set(e.cameraKey, [e]);
  }
  const groups: { headOrderMs: number; codes: string[] }[] = [];
  for (const list of byCamera.values()) {
    list.sort((a, b) => a.orderMs - b.orderMs || a.id - b.id);
    const codes: string[] = [];
    for (const e of list) {
      const due = nowMs - e.firstReceivedAtMs >= settleWindowMs;
      if (!due) break; // everything after this waits behind it
      codes.push(e.code);
    }
    if (codes.length > 0) groups.push({ headOrderMs: list[0].orderMs, codes });
  }
  groups.sort((a, b) => a.headOrderMs - b.headOrderMs);
  return groups.flatMap((g) => g.codes);
}

/**
 * Buffer (or merge onto an already-buffered) first-sighting event.
 */
export async function bufferPendingMatch(event: VideoEventInput): Promise<void> {
  const code = event.code;
  if (!code) return;
  const now = Date.now();
  let prev: BufferedPending | undefined;
  try {
    const raw = await redis.hget(EVENTS_KEY, code);
    if (raw) prev = JSON.parse(raw) as BufferedPending;
  } catch {
    prev = undefined;
  }
  const merged: BufferedPending = {
    event: mergeBufferedEvent(prev?.event, event),
    firstReceivedAtMs: prev?.firstReceivedAtMs ?? now,
    lastReceivedAtMs: now,
    attempts: prev?.attempts,
  };
  if (!prev) {
    // One durable row per video entering the buffer — lets forensics
    // measure receive→drain latency and reconstruct arrival order.
    void logVideoDecision({
      source: "webhook",
      eventType: "buffered",
      decision: "first-sighting",
      videoCode: code,
      videoId: event.id,
      cameraNumber: event.camera ?? undefined,
      systemName: event.system?.name,
      videoCreatedAt: event.created_at ?? null,
      durationS: event.duration,
      videoStatus: event.status,
      details: { cameraKey: pendingCameraKey(event), forceReady: event.forceReady || undefined },
    });
  }
  const orderMs = merged.event.created_at
    ? new Date(merged.event.created_at).getTime()
    : merged.firstReceivedAtMs;
  const pipeline = redis.pipeline();
  pipeline.hset(EVENTS_KEY, code, JSON.stringify(merged));
  pipeline.expire(EVENTS_KEY, PENDING_TTL_S);
  pipeline.zadd(ORDER_KEY, Number.isFinite(orderMs) ? orderMs : merged.firstReceivedAtMs, code);
  pipeline.expire(ORDER_KEY, PENDING_TTL_S);
  await pipeline.exec();
}

export interface DrainResult {
  drained: number;
  held: number;
  decisions: Record<string, number>;
  lockBusy?: boolean;
}

/**
 * Process every buffered event that's past its settle window, in
 * per-camera (created_at, id) order. Serialized by an NX lock so
 * concurrent webhook invocations / cron ticks never interleave
 * (interleaving would reintroduce the arrival-order bug).
 *
 * Failure handling: a processVideoEvent throw keeps the entry for
 * the next drain (attempts capped at MAX_ATTEMPTS, then dropped so a
 * poison entry can't wedge its camera's queue forever).
 */
export async function drainDuePendingMatches(opts: {
  source: ProcessSource;
  max?: number;
}): Promise<DrainResult> {
  const { source, max = 100 } = opts;
  const decisions: Record<string, number> = {};
  let drained = 0;

  const locked = await redis
    .set(DRAIN_LOCK_KEY, `${source}:${Date.now()}`, "EX", DRAIN_LOCK_TTL_S, "NX")
    .catch(() => null);
  if (locked !== "OK") return { drained: 0, held: 0, decisions, lockBusy: true };

  try {
    const rawAll = (await redis.hgetall(EVENTS_KEY)) as Record<string, string>;
    const entries: DrainPlanEntry[] = [];
    const byCode = new Map<string, BufferedPending>();
    for (const [code, raw] of Object.entries(rawAll || {})) {
      try {
        const parsed = JSON.parse(raw) as BufferedPending;
        byCode.set(code, parsed);
        const orderMs = parsed.event.created_at
          ? new Date(parsed.event.created_at).getTime()
          : parsed.firstReceivedAtMs;
        entries.push({
          code,
          cameraKey: pendingCameraKey(parsed.event),
          orderMs: Number.isFinite(orderMs) ? orderMs : parsed.firstReceivedAtMs,
          id: parsed.event.id || 0,
          firstReceivedAtMs: parsed.firstReceivedAtMs,
        });
      } catch {
        // Unparseable — drop it so it can't wedge the drain.
        await redis.hdel(EVENTS_KEY, code).catch(() => void 0);
        await redis.zrem(ORDER_KEY, code).catch(() => void 0);
      }
    }

    const order = planDrainOrder(entries, Date.now(), settleMs()).slice(0, max);
    for (const code of order) {
      const pending = byCode.get(code);
      if (!pending) continue;
      try {
        const result = await processVideoEvent(pending.event, { source });
        decisions[result.decision] = (decisions[result.decision] || 0) + 1;
        drained++;
        await redis.hdel(EVENTS_KEY, code).catch(() => void 0);
        await redis.zrem(ORDER_KEY, code).catch(() => void 0);
      } catch (err) {
        const attempts = (pending.attempts || 0) + 1;
        console.error(
          `[video-pending:${source}] processVideoEvent(${code}) failed (attempt ${attempts}):`,
          err,
        );
        if (attempts >= MAX_ATTEMPTS) {
          await redis.hdel(EVENTS_KEY, code).catch(() => void 0);
          await redis.zrem(ORDER_KEY, code).catch(() => void 0);
          decisions["dropped-after-retries"] = (decisions["dropped-after-retries"] || 0) + 1;
        } else {
          pending.attempts = attempts;
          await redis.hset(EVENTS_KEY, code, JSON.stringify(pending)).catch(() => void 0);
        }
      }
    }

    if (drained > 0) {
      void logVideoDecision({
        source,
        eventType: "drain-summary",
        decision: "drained",
        details: { drained, held: entries.length - drained, decisions, settleMs: settleMs() },
      });
    }
    return { drained, held: entries.length - drained, decisions };
  } finally {
    await redis.del(DRAIN_LOCK_KEY).catch(() => void 0);
  }
}

/** Buffer depth — surfaced by the cron response + shadow monitor. */
export async function pendingMatchDepth(): Promise<number> {
  try {
    return await redis.hlen(EVENTS_KEY);
  } catch {
    return 0;
  }
}
