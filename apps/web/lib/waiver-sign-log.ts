import { sql, isDbConfigured } from "@/lib/db";

/**
 * Durable, retrievable log of EVERY waiver sign attempt — success, salvage and
 * failure — written SERVER-SIDE from /api/pandora/waiver.
 *
 * Why this exists separately from `waiver_acceptances`:
 *   - `waiver_acceptances` is legal E-SIGN evidence. Successes only, and it is
 *     pushed from the BROWSER, best-effort, after the fact. If Pandora rejects
 *     the signature, or the tab dies, or the network drops on the way back,
 *     nothing durable is written at all.
 *   - This table is operational truth: what we SENT, what Pandora ANSWERED, and
 *     on which attempt. It is written by the route itself, so it survives the
 *     client entirely.
 *
 * The whole point (owner 2026-07-30: "last time you made a waiver program you had
 * no signatures sent... should have full logging to something we can retrieve"):
 * a silent non-write must leave a row behind. `console.log` alone could not
 * answer "did THIS guest's signature reach BMI, and if not, why" — Vercel logs
 * age out and are not queryable per person.
 *
 * Failures here are swallowed. An audit write must never cost a guest their
 * signature.
 */

export type WaiverSignOutcome =
  /** Pandora returned a waiverID. */
  | "signed"
  /** Pandora errored but the waiver is valid anyway (write-then-500) — the
   *  business outcome we need, recorded distinctly so it stays visible. */
  | "salvaged"
  /** All attempts failed and the waiver is NOT valid. The guest did not get a
   *  waiver; this is the row someone must be able to find. */
  | "failed";

export interface WaiverSignAttempt {
  /** Subject of the waiver (the minor, when a guardian signs). */
  personId: string;
  /** Who actually signed (Pandora sigPersonID). Equals personId on a self-sign. */
  signerPersonId: string;
  waiverContentId: string;
  /** Pandora locationID actually used. */
  locationId: string;
  /** The invalidationDate we SENT — blank is what makes Pandora 400. */
  invalidationDate: string;
  /** True when the caller sent none and we defaulted it. */
  invalidationDefaulted: boolean;
  /** Signature PNG size in bytes — 0 would mean an empty pad reached us. */
  signatureBytes: number;
  /** Which attempt (1-3) produced this outcome. */
  attempts: number;
  outcome: WaiverSignOutcome;
  waiverId?: string | null;
  /** Last HTTP status from Pandora (null on a network error). */
  httpStatus?: number | null;
  /** Pandora's message / our error text, trimmed. */
  upstreamMessage?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS waiver_sign_attempts (
      id                     BIGSERIAL PRIMARY KEY,
      ts                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      person_id              TEXT NOT NULL,
      signer_person_id       TEXT NOT NULL,
      waiver_content_id      TEXT NOT NULL,
      location_id            TEXT NOT NULL,
      invalidation_date      TEXT,
      invalidation_defaulted BOOLEAN NOT NULL DEFAULT FALSE,
      signature_bytes        INTEGER NOT NULL DEFAULT 0,
      attempts               INTEGER NOT NULL DEFAULT 1,
      outcome                TEXT NOT NULL,
      waiver_id              TEXT,
      http_status            INTEGER,
      upstream_message       TEXT,
      ip_address             TEXT,
      user_agent             TEXT
    )
  `;
  // Retrieval patterns: "this guest's history", "what failed lately".
  await q`CREATE INDEX IF NOT EXISTS waiver_sign_person_idx ON waiver_sign_attempts(person_id, ts DESC)`;
  await q`CREATE INDEX IF NOT EXISTS waiver_sign_failed_idx ON waiver_sign_attempts(ts DESC) WHERE outcome <> 'signed'`;
  schemaReady = true;
}

/** Record one sign outcome. Never throws. */
export async function logWaiverSignAttempt(a: WaiverSignAttempt): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[waiver-sign-log] DATABASE_URL not configured — skipping write");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO waiver_sign_attempts (
        person_id, signer_person_id, waiver_content_id, location_id,
        invalidation_date, invalidation_defaulted, signature_bytes, attempts,
        outcome, waiver_id, http_status, upstream_message, ip_address, user_agent
      ) VALUES (
        ${String(a.personId)}, ${String(a.signerPersonId)}, ${String(a.waiverContentId)},
        ${a.locationId}, ${a.invalidationDate || null}, ${a.invalidationDefaulted},
        ${a.signatureBytes}, ${a.attempts}, ${a.outcome}, ${a.waiverId ?? null},
        ${a.httpStatus ?? null}, ${(a.upstreamMessage ?? "").slice(0, 500) || null},
        ${a.ipAddress ?? null}, ${(a.userAgent ?? "").slice(0, 300) || null}
      )
    `;
  } catch (err) {
    console.error(
      `[waiver-sign-log] write failed (person=${a.personId} outcome=${a.outcome}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

export interface WaiverSignAttemptRow extends WaiverSignAttempt {
  id: number;
  ts: string;
}

/** Retrieval: one person's sign history, newest first. */
export async function listSignAttemptsForPerson(
  personId: string,
  limit = 50,
): Promise<WaiverSignAttemptRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM waiver_sign_attempts
    WHERE person_id = ${String(personId)} OR signer_person_id = ${String(personId)}
    ORDER BY ts DESC LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  return rows as unknown as WaiverSignAttemptRow[];
}

/** Retrieval: recent NON-successes — the "did anyone lose a signature" view. */
export async function listRecentSignFailures(limit = 100): Promise<WaiverSignAttemptRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM waiver_sign_attempts
    WHERE outcome <> 'signed'
    ORDER BY ts DESC LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  return rows as unknown as WaiverSignAttemptRow[];
}
