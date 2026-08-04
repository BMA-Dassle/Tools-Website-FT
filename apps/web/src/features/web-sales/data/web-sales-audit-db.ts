/**
 * Who did what to a sale, from the board.
 *
 * ONE generic table rather than a log per source, so the drawer's timeline works
 * identically for every adapter and adapter #2 does not have to rebuild it. The
 * `source`/`ref` pair is the same opaque handle the board already passes around.
 *
 * WHAT THIS IS NOT: the system of record for anything. Voucher sends already land
 * in `voucher_events`, and refunds will own their own ledger. This records the
 * ADMIN ACTION — that a human clicked resend at 9:42pm and sent it somewhere
 * other than the address on file — which is the part nothing else captures and
 * the part you want when a guest says they never got it.
 *
 * `actor` is "admin" today. There is one shared `ADMIN_CAMERA_TOKEN` and no
 * per-user admin identity in this codebase, so a name here would be fiction.
 * The column exists so that when an identity does arrive, the history is already
 * shaped for it.
 *
 * Writes are BEST-EFFORT. An audit failure must never fail the action it is
 * describing: losing the log line is bad, refusing to resend a guest's voucher
 * because the log write timed out is worse.
 */

import { sql, isDbConfigured } from "@ft/db";

export type WebSaleActionKind = "resend" | "refund" | "void";

export interface WebSaleActionRow {
  id: number;
  source: string;
  ref: string;
  action: string;
  actor: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS web_sales_actions (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        ref TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'admin',
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // The drawer reads one sale's history, newest first.
    await q`
      CREATE INDEX IF NOT EXISTS web_sales_actions_sale
      ON web_sales_actions (source, ref, created_at DESC)
    `;
  })();
  return schemaReady;
}

/** Record an admin action. Never throws — see the file header. */
export async function recordSaleAction(args: {
  source: string;
  ref: string;
  action: WebSaleActionKind;
  actor: string;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO web_sales_actions (source, ref, action, actor, detail)
      VALUES (${args.source}, ${args.ref}, ${args.action}, ${args.actor},
              ${args.detail ? JSON.stringify(args.detail) : null}::jsonb)
    `;
  } catch (err) {
    console.error("[web-sales] audit write failed (non-fatal):", err);
  }
}

/** One sale's admin history, newest first. */
export async function listSaleActions(
  source: string,
  ref: string,
  limit = 50,
): Promise<WebSaleActionRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM web_sales_actions
    WHERE source = ${source} AND ref = ${ref}
    ORDER BY created_at DESC
    LIMIT ${Math.min(200, Math.max(1, limit))}
  `) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    source: String(r.source),
    ref: String(r.ref),
    action: String(r.action),
    actor: String(r.actor),
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}
