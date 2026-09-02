/**
 * Durable audit for STAFF actions taken against Intercard from /kiosk/staff —
 * today that is exactly one action: clearing a card (`TPI_ClearAccount`).
 *
 * A clear DE-REGISTERS the account: whatever value it held is gone from the
 * guest's hands, and the call carries no transaction id to reconcile against
 * later. So every ATTEMPT writes a row — including refusals and ambiguous
 * outcomes — with the balance read just before the call. That pre-balance is
 * the paper trail: if a guest comes back saying "my card died with $20 on it",
 * this table answers what the card held and which kiosk/PIN-holder cleared it.
 *
 * Best-effort on the WRITE (a logging outage must not take the staff page
 * down) but the caller logs attempts BEFORE acting where possible — see the
 * clear-card route action. Lazy CREATE TABLE, no migrations framework — same
 * shape as consolidations-log.ts / transactions-log.ts.
 */
import { sql, isDbConfigured } from "@ft/db";

export type StaffClearOutcome =
  | "cleared" // Intercard returned 0
  | "refused" // we refused to send it (balance present without override, bad confirm)
  | "failed" // Intercard returned a non-zero code
  | "unknown"; // the call errored/timed out — NOT retried; re-read the account instead

export interface StaffClearRecord {
  /** Idempotency id for the attempt (also the tpiTransactionID sent upstream). */
  id: string;
  locationCode: number;
  accountNumber: string;
  /** Which kiosk's staff page did it (`FT:1`); null if the device is unprovisioned. */
  kioskId: string | null;
  /** Live tokens read immediately before the call; null when the read failed. */
  preTokens: number | null;
  preBonusTokens: number | null;
  outcome: StaffClearOutcome;
  /** Intercard result code / transport, or the refusal reason. */
  detail?: string;
}

let schemaReady = false;
async function ensureSchema(q: ReturnType<typeof sql>): Promise<void> {
  if (schemaReady) return;
  await q`
    CREATE TABLE IF NOT EXISTS intercard_staff_actions (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      location_code INTEGER NOT NULL,
      account_number TEXT NOT NULL,
      kiosk_id TEXT,
      pre_tokens INTEGER,
      pre_bonus_tokens INTEGER,
      outcome TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // The dispute lookup: everything that ever happened to one account.
  await q`
    CREATE INDEX IF NOT EXISTS isa_acct
    ON intercard_staff_actions (account_number, created_at DESC)
  `;
  schemaReady = true;
}

/** Record one clear-card attempt. Swallows — the audit must never be the thing
 *  that breaks the staff page (the caller has already decided/acted). */
export async function logStaffClear(rec: StaffClearRecord): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    const q = sql();
    await ensureSchema(q);
    await q`
      INSERT INTO intercard_staff_actions (
        id, action, location_code, account_number, kiosk_id,
        pre_tokens, pre_bonus_tokens, outcome, detail
      ) VALUES (
        ${rec.id}, 'clear-card', ${rec.locationCode}, ${rec.accountNumber}, ${rec.kioskId},
        ${rec.preTokens}, ${rec.preBonusTokens}, ${rec.outcome}, ${rec.detail ?? null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (err) {
    console.error("[staff-actions-log] write failed:", err instanceof Error ? err.message : err);
  }
}
