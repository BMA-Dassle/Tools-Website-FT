import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getAssignmentAtTime, type CameraAssignment } from "@/lib/camera-assign";
import {
  getMatchByVideoCode,
  isVideoReadyForNotify,
  type VideoMatch,
} from "@/lib/video-match";
import { logShadowDecision, type ShadowDecision } from "@/lib/vt3-shadow-log";

/**
 * VT3 shadow consumer — drains the Redis FIFO populated by the
 * /api/webhooks/vt3-video-event webhook and logs what a push-driven
 * queue consumer WOULD do for each event, without taking any action.
 *
 * No SMS sent. No match records written. No Redis state mutated
 * other than popping events off the queue and logging into Neon.
 *
 * Purpose: validate the queue-consumer architecture against the
 * existing /api/cron/video-match polling cron. After 2 weeks of
 * shadow data we compare:
 *   - Decision counts vs. actual cron sends
 *   - "would-notify" decisions vs. real notifications fired
 *   - Coverage gaps (events the queue saw but the cron missed, or
 *     vice versa)
 *
 * Schedule (vercel.json): every minute. Queue cap is 5000 entries
 * with 24h TTL — even at peak race weekends we'd see a few hundred
 * events/hour, well within budget.
 *
 * Bounded by `limit` (default 200) so a sustained spike can't
 * burn the cron's 60s function ceiling. Anything left rolls into
 * the next tick.
 */

const QUEUE_KEY = "vt3:events:queue";
const LOCK_KEY = "cron-lock:vt3-shadow-consumer";
const LOCK_TTL = 90;

interface QueuedEvent {
  videoCode: string;
  videoId: number | null;
  innerType: string;
  status: string | null;
  sampleUrl?: string;
  receivedAt: string;
  // We also want a few more fields for the shadow decision tree —
  // the webhook will extend its enqueue payload to include these
  // in a follow-up. For now they may be undefined and the consumer
  // logs that gracefully.
  systemName?: string;
  createdAt?: string;
  sampleUploadTime?: string | null;
  cameraNumber?: number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.max(
    1,
    Math.min(1000, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200),
  );

  // Single-flight lock — same pattern as the video-match cron.
  if (!dryRun) {
    const acquired = await redis.set(LOCK_KEY, "1", "EX", LOCK_TTL, "NX");
    if (!acquired) {
      return NextResponse.json(
        { ok: true, locked: true, note: "previous run still in flight" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const started = Date.now();
  let drained = 0;
  let errors = 0;
  const decisionCounts: Record<string, number> = {};

  try {
    // Pop up to `limit` entries from the right end of the list
    // (FIFO order — webhook LPUSHes to the left, so RPOP drains
    // oldest-first).
    for (let i = 0; i < limit; i++) {
      const raw = await redis.rpop(QUEUE_KEY);
      if (!raw) break;
      drained++;

      let evt: QueuedEvent;
      try {
        evt = JSON.parse(raw) as QueuedEvent;
      } catch {
        await logShadowDecision({
          videoCode: "(unparseable)",
          innerEventType: "(unknown)",
          status: null,
          decision: "error",
          matchExisted: false,
          assignmentFound: false,
          notes: "JSON.parse failed on queue entry",
          details: { raw: raw.slice(0, 200) },
        });
        errors++;
        continue;
      }

      try {
        const decision = await classifyEvent(evt);
        await logShadowDecision(decision);
        decisionCounts[decision.decision] = (decisionCounts[decision.decision] ?? 0) + 1;
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : "unknown";
        await logShadowDecision({
          videoCode: evt.videoCode,
          innerEventType: evt.innerType,
          status: evt.status,
          decision: "error",
          matchExisted: false,
          assignmentFound: false,
          notes: msg,
          details: { videoId: evt.videoId },
          receivedAt: evt.receivedAt,
        });
      }

      // Hard ceiling — 50s into the run, stop and let the next
      // tick pick up the rest. Vercel cuts the function at 60s.
      if (Date.now() - started > 50_000) break;
    }
  } finally {
    if (!dryRun) {
      try {
        await redis.del(LOCK_KEY);
      } catch { /* lock will TTL out */ }
    }
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[vt3-shadow-consumer] drained=${drained} errors=${errors} elapsed=${elapsedMs}ms decisions=${JSON.stringify(decisionCounts)}`,
  );

  return NextResponse.json(
    {
      ok: true,
      drained,
      errors,
      elapsedMs,
      decisions: decisionCounts,
      dryRun,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Run the production cron's decision tree against one event,
 * WITHOUT any side effects. Returns the shadow decision + context.
 */
async function classifyEvent(
  evt: QueuedEvent,
): Promise<{
  videoCode: string;
  innerEventType: string;
  status: string | null;
  decision: ShadowDecision;
  matchExisted: boolean;
  assignmentFound: boolean;
  notes?: string;
  details?: Record<string, unknown>;
  receivedAt?: string;
}> {
  const base = {
    videoCode: evt.videoCode,
    innerEventType: evt.innerType,
    status: evt.status,
    receivedAt: evt.receivedAt,
  } as const;

  // EXPIRED is a terminal state — production cron flips a flag and
  // moves on. Shadow path: would mark the record cleaned up.
  if (evt.status === "EXPIRED") {
    const existing = await getMatchByVideoCode(evt.videoCode);
    return {
      ...base,
      decision: "cleanup-expired",
      matchExisted: !!existing,
      assignmentFound: false,
      notes: existing ? "match exists, would mark expired" : "no match, would no-op",
    };
  }

  // Look up existing match — if one exists, this is an "update"
  // event, not a fresh match.
  const match: VideoMatch | null = await getMatchByVideoCode(evt.videoCode);
  const matchExisted = !!match;

  // For events without enough context to do an assignment lookup
  // (the webhook's compact entry didn't include systemName/createdAt
  // yet), classify as ignored with a note. Future webhook extension
  // adds these fields and unblocks the full decision tree.
  if (!evt.systemName || !evt.createdAt) {
    return {
      ...base,
      decision: "ignored-not-message",
      matchExisted,
      assignmentFound: false,
      notes: "queue entry missing systemName/createdAt — webhook needs extension",
      details: { evt },
    };
  }

  // Camera-assignment lookup at the time the kart was running.
  let assignment: CameraAssignment | null = null;
  try {
    assignment = await getAssignmentAtTime(evt.systemName, evt.createdAt);
  } catch (err) {
    return {
      ...base,
      decision: "error",
      matchExisted,
      assignmentFound: false,
      notes: err instanceof Error ? err.message : "assignment lookup threw",
    };
  }
  const assignmentFound = !!assignment;

  // Ready signal from the event payload — same gate the cron uses.
  const isReady = isVideoReadyForNotify({
    status: evt.status ?? undefined,
    sampleUploadTime: evt.sampleUploadTime ?? null,
  });

  // ── Decision tree (mirrors cron route's per-video logic) ──
  if (!matchExisted) {
    if (!assignmentFound) {
      return {
        ...base,
        decision: "skip-no-assignment",
        matchExisted,
        assignmentFound,
        notes: `no racer assigned to system ${evt.systemName} at ${evt.createdAt}`,
      };
    }
    if (isReady) {
      return {
        ...base,
        decision: "save-and-notify",
        matchExisted,
        assignmentFound,
        notes: `would create match + fire notify (ready=${!!evt.sampleUploadTime})`,
      };
    }
    return {
      ...base,
      decision: "save-pending",
      matchExisted,
      assignmentFound,
      notes: `would save pending match — VT3 not ready yet (status=${evt.status})`,
    };
  }

  // Match already exists — either deferred-notify, overlay update,
  // or no-op. Without inspecting all the notify-* fields here we
  // can't perfectly mirror the cron, but we capture the high level.
  if (match && !match.notifySmsOk && !match.notifyEmailOk) {
    if (isReady) {
      return {
        ...base,
        decision: "fire-deferred-notify",
        matchExisted,
        assignmentFound,
        notes: "pending match became ready — cron would fire notify",
      };
    }
    return {
      ...base,
      decision: "skip-already-notified",
      matchExisted,
      assignmentFound,
      notes: "match exists, still pending, not yet ready",
    };
  }

  // Match exists + already notified → overlay refresh on viewed /
  // purchased / unlock changes. Without diffing every field here
  // (which would require another Redis read) we conservatively log
  // "update-overlay" — the actual cron will skip if nothing differs.
  return {
    ...base,
    decision: "update-overlay",
    matchExisted,
    assignmentFound,
    notes: "match exists + notified — would consider overlay refresh",
  };
}
