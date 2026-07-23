/**
 * Durable audit for card CONSOLIDATIONS (move all value from a source card onto
 * a target card, via the on-prem bridge → EIS). One row per source consumed.
 *
 * Architecture note: the bridge lives on the kiosk PC's localhost, so the MOVE
 * is issued by the kiosk BROWSER (like creditTokensViaBridge); this row is
 * written by the browser POSTing the OUTCOME to /api/game-cards/consolidate
 * afterward. A consolidation moves no money in/out (it relocates existing token
 * value between the customer's own accounts) and runs interactively with staff
 * present, so there is no reconcile cron: the kiosk is money-safe by only binning
 * a source after a confirmed "done" and holding for staff on "unknown". This
 * table is the paper trail for those holds — an "unknown" row with both accounts
 * recorded is what staff use to check Intercard reports.
 *
 * Best-effort: a logging failure must NEVER surface to the guest (the value move
 * already happened on the EIS, the authority). Lazy CREATE TABLE, no migrations
 * framework — same shape as transactions-log.ts.
 */
import { sql, isDbConfigured } from "@ft/db";

export type ConsolidationOutcome = "done" | "declined" | "unknown";

let schemaReady = false;
async function ensureSchema(q: ReturnType<typeof sql>): Promise<void> {
  if (schemaReady) return;
  await q`
    CREATE TABLE IF NOT EXISTS intercard_consolidations (
      id TEXT PRIMARY KEY,
      location_code INTEGER NOT NULL,
      source_account TEXT NOT NULL,
      target_account TEXT NOT NULL,
      pre_tokens INTEGER,
      pre_bonus_tokens INTEGER,
      outcome TEXT NOT NULL,
      code TEXT,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // The report staff scan after a hold: unknown-outcome rows, newest first.
  await q`
    CREATE INDEX IF NOT EXISTS icc_unknown
    ON intercard_consolidations (created_at)
    WHERE outcome = 'unknown'
  `;
  schemaReady = true;
}

export interface ConsolidationRecord {
  id: string;
  locationCode: number;
  sourceAccount: string;
  targetAccount: string;
  /** Source balance read just before the move (display + audit); null if unread. */
  preTokens: number | null;
  preBonusTokens: number | null;
  outcome: ConsolidationOutcome;
  code?: string;
  description?: string;
}

/** Record one source→target move outcome. Best-effort — swallows so a log outage
 *  never surfaces (the EIS already moved the value; the kiosk stayed money-safe
 *  via confirmed-before-bin). */
export async function logConsolidation(rec: ConsolidationRecord): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    const q = sql();
    await ensureSchema(q);
    await q`
      INSERT INTO intercard_consolidations (
        id, location_code, source_account, target_account,
        pre_tokens, pre_bonus_tokens, outcome, code, description
      ) VALUES (
        ${rec.id}, ${rec.locationCode}, ${rec.sourceAccount}, ${rec.targetAccount},
        ${rec.preTokens}, ${rec.preBonusTokens}, ${rec.outcome},
        ${rec.code ?? null}, ${rec.description ?? null}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (err) {
    console.error("[consolidations-log] write failed:", err instanceof Error ? err.message : err);
  }
}
