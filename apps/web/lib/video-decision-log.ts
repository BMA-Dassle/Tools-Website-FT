import { sql, isDbConfigured } from "@/lib/db";

/**
 * Durable video-pipeline decision log — Neon-backed forensics
 * (2026-08-02 hardening).
 *
 * WHY: every record this pipeline keeps is Redis-with-TTL — camera
 * assignments 24h, blocks 14d, match/unmatched records 30d. During
 * the 8/2 wrong-video investigation, several guest complaints (which
 * arrive DAYS after the race) were literally unprovable because the
 * evidence had already expired. This table is the append-only paper
 * trail: one row per pipeline decision, so "who got matched to what,
 * from which candidates, and what did we send" survives forever.
 *
 * Logged event_types:
 *   match         — every matchVideoToAssignment outcome (saved /
 *                   junk-short / no-assignment / held-duplicate),
 *                   with candidate context + displaced junk code
 *   notify        — every automated notify fire (SMS + email
 *                   outcomes, recipient)
 *   block-flip    — block state changed on an existing match
 *   buffered      — first sighting entered the ordered pending
 *                   buffer (one row per video, not per event)
 *   drain-summary — an ordered drain that processed ≥1 video
 *
 * Fire-and-forget: callers `void logVideoDecision(...)` — a Neon
 * hiccup must never block a match or an SMS. Failures warn to logs.
 *
 * IDs: session_id / person_id stored as TEXT — Pandora/BMI ids can
 * exceed Number.MAX_SAFE_INTEGER; never Number() them downstream.
 */

export interface VideoDecisionEntry {
  source: string; // cron | webhook | manual
  eventType: "match" | "notify" | "block-flip" | "buffered" | "drain-summary";
  decision?: string;
  videoCode?: string;
  videoId?: number;
  cameraNumber?: number | null;
  systemName?: string;
  videoCreatedAt?: string | null;
  durationS?: number | null;
  videoStatus?: string | null;
  sessionId?: string | number;
  personId?: string | number;
  racer?: string;
  heatNumber?: number;
  track?: string;
  candidateCount?: number;
  displacedCode?: string;
  existingCode?: string;
  notifySmsOk?: boolean;
  notifySmsTo?: string;
  notifySmsError?: string;
  notifyEmailOk?: boolean;
  notifyEmailTo?: string;
  viaGuardian?: boolean;
  /** Anything else useful later. Avoid signed URLs (they inflate the
   *  table and expire anyway). */
  details?: Record<string, unknown>;
}

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS video_decision_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      decision TEXT,
      video_code TEXT,
      video_id BIGINT,
      camera_number INT,
      system_name TEXT,
      video_created_at TIMESTAMPTZ,
      duration_s INT,
      video_status TEXT,
      session_id TEXT,
      person_id TEXT,
      racer TEXT,
      heat_number INT,
      track TEXT,
      candidate_count INT,
      displaced_code TEXT,
      existing_code TEXT,
      notify_sms_ok BOOLEAN,
      notify_sms_to TEXT,
      notify_sms_error TEXT,
      notify_email_ok BOOLEAN,
      notify_email_to TEXT,
      via_guardian BOOLEAN,
      details JSONB
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS video_decision_log_ts_idx ON video_decision_log(ts DESC)`;
  await q`CREATE INDEX IF NOT EXISTS video_decision_log_code_idx ON video_decision_log(video_code)`;
  await q`CREATE INDEX IF NOT EXISTS video_decision_log_person_idx ON video_decision_log(person_id)`;
  await q`CREATE INDEX IF NOT EXISTS video_decision_log_type_idx ON video_decision_log(event_type, decision)`;
  schemaReady = true;
}

/**
 * Append one decision. Never throws; never block on this — call as
 * `void logVideoDecision({...})`.
 */
export async function logVideoDecision(entry: VideoDecisionEntry): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO video_decision_log (
        source, event_type, decision, video_code, video_id, camera_number,
        system_name, video_created_at, duration_s, video_status,
        session_id, person_id, racer, heat_number, track,
        candidate_count, displaced_code, existing_code,
        notify_sms_ok, notify_sms_to, notify_sms_error,
        notify_email_ok, notify_email_to, via_guardian, details
      ) VALUES (
        ${entry.source},
        ${entry.eventType},
        ${entry.decision ?? null},
        ${entry.videoCode ?? null},
        ${typeof entry.videoId === "number" && entry.videoId > 0 ? entry.videoId : null},
        ${typeof entry.cameraNumber === "number" ? entry.cameraNumber : null},
        ${entry.systemName ?? null},
        ${entry.videoCreatedAt ?? null},
        ${typeof entry.durationS === "number" && Number.isFinite(entry.durationS) ? Math.round(entry.durationS) : null},
        ${entry.videoStatus ?? null},
        ${entry.sessionId != null ? String(entry.sessionId) : null},
        ${entry.personId != null ? String(entry.personId) : null},
        ${entry.racer ?? null},
        ${typeof entry.heatNumber === "number" ? entry.heatNumber : null},
        ${entry.track ?? null},
        ${typeof entry.candidateCount === "number" ? entry.candidateCount : null},
        ${entry.displacedCode ?? null},
        ${entry.existingCode ?? null},
        ${entry.notifySmsOk ?? null},
        ${entry.notifySmsTo ?? null},
        ${entry.notifySmsError ?? null},
        ${entry.notifyEmailOk ?? null},
        ${entry.notifyEmailTo ?? null},
        ${entry.viaGuardian ?? null},
        ${entry.details ? JSON.stringify(entry.details) : null}::jsonb
      )
    `;
  } catch (err) {
    console.warn("[video-decision-log] write failed (non-fatal):", err);
  }
}
