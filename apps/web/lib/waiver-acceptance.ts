import { sql, isDbConfigured } from "@/lib/db";

/**
 * Waiver electronic-acceptance log — the attribution record we never had.
 *
 * Every time a guest accepts a waiver electronically (the accept checkbox), OR
 * we backfill a provable prior acceptance, we write one row here. This is the
 * retained, attributable record E-SIGN / FL UETA §668.50 expects: who, what
 * terms version, when, from where (IP + user-agent), and the resulting BMI
 * waiverID.
 *
 * ── Why Postgres (not Redis) ─────────────────────────────────────
 * A liability dispute can surface long after the event. Redis TTLs would purge
 * the evidence; Postgres keeps it indefinitely at trivial cost. Mirrors the
 * lazy CREATE-TABLE pattern of lib/clickwrap.ts.
 */

export interface WaiverAcceptance {
  /** ISO timestamp of acceptance (server time at push). */
  ts: string;
  /** Server-captured IP (x-forwarded-for / x-real-ip). "backfill" for reconstructed rows. */
  ipAddress?: string;
  /** Browser user-agent ("" for backfill). */
  userAgent?: string;
  /** Waiver terms version the guest accepted. */
  termsVersion: string;
  email?: string;
  phone?: string;
  firstName?: string;
  /** BMI/Pandora personId the waiver was attached to. */
  personId: string;
  /** BMI waiverID returned by Pandora on success. */
  waiverId?: string;
  /** How acceptance was captured. */
  method: "checkbox" | "backfill";
  /** Group-event slug (e.g. "healthnet-2026"). */
  eventSlug?: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS waiver_acceptances (
      id             SERIAL PRIMARY KEY,
      ts             TIMESTAMPTZ NOT NULL,
      ip_address     TEXT,
      user_agent     TEXT,
      terms_version  TEXT NOT NULL,
      email          TEXT,
      phone          TEXT,
      first_name     TEXT,
      person_id      TEXT NOT NULL,
      waiver_id      TEXT,
      method         TEXT NOT NULL,
      event_slug     TEXT,
      inserted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS waiver_acc_person_idx ON waiver_acceptances(person_id)`;
  await q`CREATE INDEX IF NOT EXISTS waiver_acc_event_idx  ON waiver_acceptances(event_slug) WHERE event_slug IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS waiver_acc_email_idx  ON waiver_acceptances(email) WHERE email IS NOT NULL`;
  schemaReady = true;
}

/**
 * Persist one waiver acceptance. Failures are logged + swallowed — the audit
 * write must never break the guest's confirm/booking flow.
 */
export async function logWaiverAcceptance(a: WaiverAcceptance): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[waiver-acceptance] DATABASE_URL not configured — skipping write");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO waiver_acceptances (
        ts, ip_address, user_agent, terms_version,
        email, phone, first_name, person_id, waiver_id, method, event_slug
      ) VALUES (
        ${a.ts}, ${a.ipAddress ?? null}, ${a.userAgent ?? null}, ${a.termsVersion},
        ${a.email ?? null}, ${a.phone ?? null}, ${a.firstName ?? null},
        ${a.personId}, ${a.waiverId ?? null}, ${a.method}, ${a.eventSlug ?? null}
      )
    `;
  } catch (err) {
    console.error("[waiver-acceptance] write failed:", err);
  }
}
