import { sql, isDbConfigured } from "@/lib/db";

/**
 * VT3 video event shadow log — Neon-backed observation of what the
 * push-driven event reactor WOULD do, without taking any action.
 *
 * Purpose: validate the queue-consumer architecture before flipping
 * over from the polling cron. The webhook at
 * /api/webhooks/vt3-video-event populates a Redis FIFO with each
 * pushed event; the shadow consumer cron at
 * /api/cron/vt3-shadow-consumer drains that FIFO and runs the same
 * decision tree the production cron uses, but logs each decision
 * here instead of writing match records / sending SMS.
 *
 * After ~2 weeks of shadow data we can:
 *  - Compare decision counts vs. actual cron sends
 *  - Verify "would-notify" decisions correspond 1:1 with real
 *    notifications the cron fired
 *  - Spot any divergence (queue races, missing event types, edge
 *    cases the polling cron handles but push doesn't)
 *
 * Auto-bootstraps schema on first write. Idempotent ALTER TABLE
 * additions are safe across deploys.
 */

export type ShadowDecision =
  | "skip-no-assignment"      // unassigned camera → cron would skip too
  | "save-and-notify"          // first sighting + ready → cron would save+notify
  | "save-pending"             // first sighting + not ready → cron would save with pendingNotify
  | "fire-deferred-notify"     // pending match becomes ready → cron would notify on this tick
  | "skip-already-notified"    // match exists, already notified, no overlay change
  | "update-overlay"           // match exists, viewed/purchased/unlock fields differ
  | "cleanup-expired"          // VT3 marked EXPIRED — cron would mark the record
  | "skip-blocked"             // camera-assignment is blocked (admin gate)
  | "ignored-not-message"      // connected event, heartbeat, or unknown
  | "error";                   // shadow processing threw

export interface ShadowLogEntry {
  videoCode: string;
  innerEventType: string;       // "video-updated" | "sample-uploaded"
  status: string | null;        // VT3 status field on the payload
  decision: ShadowDecision;
  /** Was a match record already in Redis when we processed this? */
  matchExisted: boolean;
  /** Did camera-assignment lookup find a racer? */
  assignmentFound: boolean;
  /** Optional note — error message, why we picked this decision, etc. */
  notes?: string;
  /** Compact JSON of relevant payload fields for later forensic
   *  analysis. Don't dump the whole VT3 record (signed thumbnailUrls
   *  etc. inflate the table). */
  details?: Record<string, unknown>;
  /** When the event was received (from the Redis queue entry). */
  receivedAt?: string;
}

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS vt3_shadow_events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_at TIMESTAMPTZ,
      video_code TEXT NOT NULL,
      inner_event_type TEXT NOT NULL,
      status TEXT,
      decision TEXT NOT NULL,
      match_existed BOOLEAN NOT NULL,
      assignment_found BOOLEAN NOT NULL,
      notes TEXT,
      details JSONB
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS vt3_shadow_events_ts_idx ON vt3_shadow_events(ts DESC)`;
  await q`CREATE INDEX IF NOT EXISTS vt3_shadow_events_decision_idx ON vt3_shadow_events(decision)`;
  await q`CREATE INDEX IF NOT EXISTS vt3_shadow_events_code_idx ON vt3_shadow_events(video_code)`;
  schemaReady = true;
}

/**
 * Append one shadow decision to the log. Failures swallowed with
 * a warn — shadow logging must never break production paths.
 */
export async function logShadowDecision(entry: ShadowLogEntry): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO vt3_shadow_events (
        received_at, video_code, inner_event_type, status, decision,
        match_existed, assignment_found, notes, details
      ) VALUES (
        ${entry.receivedAt ?? null},
        ${entry.videoCode},
        ${entry.innerEventType},
        ${entry.status ?? null},
        ${entry.decision},
        ${entry.matchExisted},
        ${entry.assignmentFound},
        ${entry.notes ?? null},
        ${entry.details ? JSON.stringify(entry.details) : null}::jsonb
      )
    `;
  } catch (err) {
    console.warn("[vt3-shadow-log] write failed (non-fatal):", err);
  }
}

export interface ShadowSummary {
  totalEvents: number;
  byDecision: { decision: string; count: number }[];
  /** Events received within the last 24h, useful for the admin
   *  "is the bridge healthy?" surface. */
  recentCount24h: number;
  /** Oldest unresolved (no match record after 4h+) videos —
   *  candidate misses to investigate. */
  staleVideos?: { videoCode: string; ts: string; decision: string }[];
}

export async function summarizeShadow(sinceHours = 24): Promise<ShadowSummary> {
  const empty: ShadowSummary = {
    totalEvents: 0,
    byDecision: [],
    recentCount24h: 0,
  };
  if (!isDbConfigured()) return empty;
  await ensureSchema();
  const q = sql();
  const totals = (await q`
    SELECT COUNT(*)::int AS count
    FROM vt3_shadow_events
    WHERE ts > NOW() - (${sinceHours}::int || ' hours')::interval
  `) as Array<{ count: number }>;
  const byDecision = (await q`
    SELECT decision, COUNT(*)::int AS count
    FROM vt3_shadow_events
    WHERE ts > NOW() - (${sinceHours}::int || ' hours')::interval
    GROUP BY decision
    ORDER BY count DESC
  `) as Array<{ decision: string; count: number }>;
  const recent = (await q`
    SELECT COUNT(*)::int AS count
    FROM vt3_shadow_events
    WHERE ts > NOW() - INTERVAL '24 hours'
  `) as Array<{ count: number }>;
  return {
    totalEvents: Number(totals[0]?.count ?? 0),
    byDecision: byDecision.map((r) => ({
      decision: String(r.decision),
      count: Number(r.count) || 0,
    })),
    recentCount24h: Number(recent[0]?.count ?? 0),
  };
}
