/**
 * Groupon voucher ledger (Neon) — OUR record of a Groupon unit and what it owes.
 *
 * WHY THIS TABLE EXISTS. Groupon redemption is ALL-OR-NOTHING: one unit gets one
 * `redeemed` PATCH and that is the end of Groupon's involvement (owner
 * 2026-08-18 — partial redemption is never sent to Groupon). But the deal is
 * five separate things (a card and four laser tag entries), taken at different
 * times, possibly days apart. So the instant we redeem, GROUPON'S COPY STOPS
 * BEING THE TRUTH and this table becomes it.
 *
 * That produces the single biggest correctness trap in the feature: after the
 * first scan, Groupon reports `redeemed` FOREVER. A resolver that asks Groupon
 * first will tell a guest holding four unspent laser tag entries that their
 * voucher is "already used". THIS TABLE IS READ FIRST, ALWAYS. Groupon is only
 * consulted for codes we have never seen.
 *
 * WHAT THIS TABLE IS NOT: it is not the single-use authority. Per-item
 * consumption stays in `voucher_claims`, whose one-statement CAS is what makes
 * two kiosks scanning the same code at the same moment safe. Duplicating that
 * here would create a second writer for the same fact, and the two would drift
 * the first time a claim failed halfway. This table holds the unit's identity,
 * its item list, and the state of our external redeem obligation — nothing that
 * `voucher_claims` already answers.
 *
 * WRITTEN AT CAPTURE, BEFORE THE EXTERNAL CALL. The row is inserted from the
 * GET response the moment a code validates, so a later PATCH failure can never
 * lose what the guest is owed (same doctrine as the Pizza Bowl toppings lesson:
 * our DB is the source of truth, external APIs are downstream syncs).
 */

import { sql, isDbConfigured } from "@ft/db";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";

/**
 * Where the external redeem obligation stands.
 *   pending — we owe Groupon a redeem PATCH (value may already be handed over).
 *   sent    — Groupon acknowledged. Terminal, happy.
 *   failed  — a TERMINAL refusal (not a transient flake). Needs a human.
 *
 * `pending` is the one that matters operationally: a row stuck there is real
 * money we handed a guest and never reported to Groupon.
 */
export type GrouponRedeemState = "pending" | "sent" | "failed";

export interface GrouponUnitRow {
  redemptionCode: string;
  unitId: string;
  grouponCode: string;
  dealKey: string | null;
  items: VoucherItem[];
  valueAmount: number | null;
  currencyCode: string | null;
  fetchedAt: string;
  redeemState: GrouponRedeemState;
  redeemedAt: string | null;
  redeemAttempts: number;
  lastError: string | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS groupon_units (
        -- The guest-presented short code is the natural key: it is what a scan
        -- or a keypad produces, and it is what every lookup starts from.
        redemption_code TEXT PRIMARY KEY,
        unit_id TEXT NOT NULL,
        groupon_code TEXT NOT NULL,
        -- Our own deal key. NULL = we recognised the voucher but have no
        -- mapping, which must grant NOTHING rather than guess.
        deal_key TEXT,
        -- The item list as granted, frozen at capture. Deliberately a SNAPSHOT,
        -- not a live lookup into GROUPON_DEALS: editing a deal map must never
        -- retroactively change what an already-scanned voucher was worth.
        items JSONB NOT NULL,
        value_amount INTEGER,
        currency_code TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        redeem_state TEXT NOT NULL DEFAULT 'pending',
        redeemed_at TIMESTAMPTZ,
        redeem_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )
    `;
    // The retry cron's only query: find what we still owe Groupon.
    await q`
      CREATE INDEX IF NOT EXISTS groupon_units_pending
        ON groupon_units (redeem_state) WHERE redeem_state = 'pending'
    `;
    await q`CREATE INDEX IF NOT EXISTS groupon_units_unit ON groupon_units (unit_id)`;
  })();
  return schemaReady;
}

function decode(r: Record<string, unknown>): GrouponUnitRow {
  return {
    redemptionCode: String(r.redemption_code),
    unitId: String(r.unit_id),
    grouponCode: String(r.groupon_code),
    dealKey: r.deal_key == null ? null : String(r.deal_key),
    items: (r.items ?? []) as VoucherItem[],
    valueAmount: r.value_amount == null ? null : Number(r.value_amount),
    currencyCode: r.currency_code == null ? null : String(r.currency_code),
    fetchedAt: String(r.fetched_at),
    redeemState: String(r.redeem_state) as GrouponRedeemState,
    redeemedAt: r.redeemed_at == null ? null : String(r.redeemed_at),
    redeemAttempts: Number(r.redeem_attempts ?? 0),
    lastError: r.last_error == null ? null : String(r.last_error),
  };
}

/** The local-first lookup. Null = we have never seen this code. */
export async function findGrouponUnit(code: string): Promise<GrouponUnitRow | null> {
  if (!isDbConfigured()) throw new Error("groupon: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM groupon_units WHERE redemption_code = ${code}
  `) as Record<string, unknown>[];
  return rows.length ? decode(rows[0]) : null;
}

/**
 * Record a validated unit. IDEMPOTENT on re-scan: a second scan of the same
 * code must NOT reset the item snapshot or the redeem state, or a guest who
 * already took the card would be handed a fresh one. Only diagnostics refresh.
 */
export async function upsertGrouponUnit(args: {
  redemptionCode: string;
  unitId: string;
  grouponCode: string;
  dealKey: string | null;
  items: VoucherItem[];
  valueAmount?: number | null;
  currencyCode?: string | null;
}): Promise<GrouponUnitRow> {
  if (!isDbConfigured()) throw new Error("groupon: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO groupon_units
      (redemption_code, unit_id, groupon_code, deal_key, items, value_amount, currency_code)
    VALUES
      (${args.redemptionCode}, ${args.unitId}, ${args.grouponCode}, ${args.dealKey},
       ${JSON.stringify(args.items)}::jsonb, ${args.valueAmount ?? null},
       ${args.currencyCode ?? null})
    ON CONFLICT (redemption_code) DO UPDATE SET
      unit_id = EXCLUDED.unit_id,
      groupon_code = EXCLUDED.groupon_code,
      fetched_at = NOW()
    RETURNING *
  `) as Record<string, unknown>[];
  return decode(rows[0]);
}

/** Groupon accepted the redeem. Terminal. */
export async function markGrouponRedeemed(code: string): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE groupon_units
       SET redeem_state = 'sent', redeemed_at = NOW(), last_error = NULL
     WHERE redemption_code = ${code}
  `;
}

/**
 * A redeem attempt did not land. `terminal` distinguishes "Groupon refused and
 * will keep refusing" from "try again later" — only the latter stays `pending`
 * for the cron. Attempts always increment so a hot-looping row is visible.
 */
export async function markGrouponRedeemFailure(
  code: string,
  error: string,
  terminal: boolean,
): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE groupon_units
       SET redeem_attempts = redeem_attempts + 1,
           last_error = ${error.slice(0, 500)},
           redeem_state = ${terminal ? "failed" : "pending"}
     WHERE redemption_code = ${code}
  `;
}

/** The retry cron's worklist: value handed over, Groupon not yet told. */
export async function listPendingRedeems(limit = 50): Promise<GrouponUnitRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM groupon_units
     WHERE redeem_state = 'pending'
     ORDER BY fetched_at ASC
     LIMIT ${limit}
  `) as Record<string, unknown>[];
  return rows.map(decode);
}
