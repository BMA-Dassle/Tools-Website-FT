/**
 * Links a Square customer to the Intercard game-card account numbers they own,
 * so a signed-in guest sees their cards without typing the number and we can
 * show which of their Square accounts have game cards.
 *
 * Lazy CREATE TABLE IF NOT EXISTS (no migrations framework — mirrors
 * card-vault/data.ts and transactions-log.ts). Account numbers are TEXT and
 * kept as strings end-to-end (Intercard bigint precision).
 */
import { sql, isDbConfigured } from "@ft/db";

export interface LinkedCardRow {
  squareCustomerId: string;
  accountNumber: string;
  locationCode: number | null;
  label: string | null;
  createdAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS customer_game_cards (
      id BIGSERIAL PRIMARY KEY,
      square_customer_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      location_code INTEGER,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (square_customer_id, account_number)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS cgc_customer ON customer_game_cards (square_customer_id)`;
  schemaReady = true;
}

/** Associate a game card with a Square customer (idempotent upsert). */
export async function linkCard(params: {
  squareCustomerId: string;
  accountNumber: string;
  locationCode?: number | null;
  label?: string | null;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO customer_game_cards (square_customer_id, account_number, location_code, label)
    VALUES (${params.squareCustomerId}, ${params.accountNumber}, ${params.locationCode ?? null}, ${params.label ?? null})
    ON CONFLICT (square_customer_id, account_number) DO UPDATE SET
      location_code = COALESCE(EXCLUDED.location_code, customer_game_cards.location_code),
      label = COALESCE(EXCLUDED.label, customer_game_cards.label)
  `;
}

/** Set the customer's nickname (label) for a linked card. */
export async function renameCard(
  squareCustomerId: string,
  accountNumber: string,
  nickname: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE customer_game_cards SET label = ${nickname}
    WHERE square_customer_id = ${squareCustomerId} AND account_number = ${accountNumber}
  `;
}

export async function unlinkCard(squareCustomerId: string, accountNumber: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    DELETE FROM customer_game_cards
    WHERE square_customer_id = ${squareCustomerId} AND account_number = ${accountNumber}
  `;
}

export async function listCardsForCustomer(squareCustomerId: string): Promise<LinkedCardRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT square_customer_id, account_number, location_code, label, created_at
      FROM customer_game_cards
      WHERE square_customer_id = ${squareCustomerId}
      ORDER BY created_at ASC
    `;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return rows.map((r: any) => ({
      squareCustomerId: r.square_customer_id,
      accountNumber: r.account_number,
      locationCode: r.location_code,
      label: r.label,
      createdAt: r.created_at,
    }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
  } catch {
    return [];
  }
}

/** Count of linked game cards per Square customer id (for the account picker). */
export async function countsByCustomer(
  squareCustomerIds: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of squareCustomerIds) out[id] = 0;
  if (!isDbConfigured() || squareCustomerIds.length === 0) return out;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT square_customer_id, COUNT(*)::int AS n
      FROM customer_game_cards
      WHERE square_customer_id = ANY(${squareCustomerIds})
      GROUP BY square_customer_id
    `;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (const r of rows as any[]) out[r.square_customer_id] = r.n;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return out;
  } catch {
    return out;
  }
}
