/**
 * Kiosk split-tender ledger (Neon) — the durable record of every split
 * checkout attempt: which gift card was authorized for how much, which reader
 * payment joined it, and whether the set was captured.
 *
 * HOUSE HARD RULE: money state persists HERE first. The Redis terminal anchor
 * is the fast pointer; this table is what the abandon sweep and any manual
 * reconciliation read when Redis is gone. One row per (base_key) — the same
 * deterministic key the Square idempotency scheme derives from, so a retry
 * updates its own row instead of minting a second attempt.
 *
 * Raw SQL via @/lib/db (no ORM — house rule). Self-creating schema, matching
 * the kiosk-checkins-db / kiosk-waiver-joins-db pattern. All external ids stay
 * TEXT end-to-end.
 */
import { sql, isDbConfigured } from "@/lib/db";

export type SplitAttemptState = "open" | "captured" | "canceled" | "needs_review";

export interface SplitTenderEntry {
  index: number;
  kind: "gift_card" | "terminal";
  paymentId?: string;
  amountCents: number;
  ganLast4?: string;
  status: "authorized" | "canceled" | "cancel-failed";
}

export interface SplitAttemptRow {
  id: number;
  seed: string;
  baseKey: string;
  surface: string;
  depositOrderId: string | null;
  locationId: string;
  totalCents: number;
  tenders: SplitTenderEntry[];
  state: SplitAttemptState;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_split_tenders (
      id               BIGSERIAL PRIMARY KEY,
      seed             TEXT NOT NULL,
      base_key         TEXT NOT NULL UNIQUE,
      surface          TEXT NOT NULL DEFAULT 'kiosk',
      deposit_order_id TEXT,
      location_id      TEXT NOT NULL,
      total_cents      INTEGER NOT NULL,
      tenders          JSONB NOT NULL DEFAULT '[]'::jsonb,
      state            TEXT NOT NULL DEFAULT 'open',
      attempt          INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_split_tenders_state_idx
    ON kiosk_split_tenders (state, updated_at)
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_split_tenders_seed_idx
    ON kiosk_split_tenders (seed)
  `;
  schemaReady = true;
}

function mapRow(r: Record<string, unknown>): SplitAttemptRow {
  return {
    id: Number(r.id),
    seed: String(r.seed),
    baseKey: String(r.base_key),
    surface: String(r.surface),
    depositOrderId: r.deposit_order_id == null ? null : String(r.deposit_order_id),
    locationId: String(r.location_id),
    totalCents: Number(r.total_cents),
    tenders: (Array.isArray(r.tenders) ? r.tenders : []) as SplitTenderEntry[],
    state: String(r.state) as SplitAttemptState,
    attempt: Number(r.attempt ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Open (or refresh) the attempt row — called BEFORE any Square auth. */
export async function upsertSplitAttempt(input: {
  seed: string;
  baseKey: string;
  depositOrderId: string | null;
  locationId: string;
  totalCents: number;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO kiosk_split_tenders (seed, base_key, deposit_order_id, location_id, total_cents)
    VALUES (${input.seed}, ${input.baseKey}, ${input.depositOrderId}, ${input.locationId}, ${input.totalCents})
    ON CONFLICT (base_key) DO UPDATE SET
      seed = EXCLUDED.seed,
      deposit_order_id = COALESCE(EXCLUDED.deposit_order_id, kiosk_split_tenders.deposit_order_id),
      total_cents = EXCLUDED.total_cents,
      state = 'open',
      updated_at = now()
  `;
}

/** Replace the tenders array (small N — v1 is at most gift card + tap). */
export async function setSplitTenders(
  baseKey: string,
  tenders: SplitTenderEntry[],
  attempt?: number,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE kiosk_split_tenders
    SET tenders = ${JSON.stringify(tenders)}::jsonb,
        attempt = COALESCE(${attempt ?? null}, attempt),
        updated_at = now()
    WHERE base_key = ${baseKey}
  `;
}

export async function setSplitState(baseKey: string, state: SplitAttemptState): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE kiosk_split_tenders
    SET state = ${state}, updated_at = now()
    WHERE base_key = ${baseKey}
  `;
}

export async function getSplitAttempt(baseKey: string): Promise<SplitAttemptRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM kiosk_split_tenders WHERE base_key = ${baseKey} LIMIT 1
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

/** Abandoned split attempts (the sweep's work list): open + stale. */
export async function listStaleOpenSplitAttempts(
  olderThanMinutes: number,
): Promise<SplitAttemptRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM kiosk_split_tenders
    WHERE state = 'open'
      AND updated_at < now() - make_interval(mins => ${olderThanMinutes})
    ORDER BY updated_at ASC
    LIMIT 50
  `;
  return (rows as Array<Record<string, unknown>>).map(mapRow);
}
