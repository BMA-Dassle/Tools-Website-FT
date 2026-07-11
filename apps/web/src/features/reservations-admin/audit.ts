/**
 * Generic admin-action audit for the reservations portal.
 *
 * Cancellations have their own richer table (reservation_cancel_events —
 * money movement, idempotency counter); THIS table records everything else
 * staff do to a reservation: reschedule, resend, check-in, note edits, guest
 * contact edits. The manage-reservation History tab merges both streams.
 *
 * Writes are BEST-EFFORT (log + swallow): unlike cancel events these never
 * gate money movement, and an audit hiccup must not fail the admin action.
 * There is no per-staff identity (single shared portal token), so `actor` is
 * "admin" today — the column exists so per-staff attribution can land later
 * without a migration.
 *
 * Mirrors the lazy CREATE TABLE IF NOT EXISTS pattern of
 * lib/reservation-cancel-log.ts (no migrations framework in this repo).
 */
import { neon } from "@neondatabase/serverless";

function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
function sql() {
  return neon(process.env.DATABASE_URL!);
}

export type AdminActionKind =
  | "reschedule"
  | "resend"
  | "checkin"
  | "checkin_method"
  | "notes_edit"
  | "guest_edit"
  /** Reservation edit (players/lanes/shoes/racers + money) via the edit cascade. */
  | "edit"
  /** card-vault-sweep disabled a silently captured card on file (72h rule). */
  | "card_vault_disable";

export interface AdminActionEvent {
  reservationId: number;
  action: AdminActionKind;
  outcome: "success" | "failed";
  /** Action-specific payload — from/to diffs, channels, lane labels, etc. */
  detail?: unknown;
  error?: string;
  actor?: string;
}

export interface AdminActionRow {
  id: number;
  reservationId: number;
  action: AdminActionKind;
  actor: string;
  outcome: "success" | "failed";
  detail: unknown;
  error: string | null;
  createdAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS admin_action_events (
      id BIGSERIAL PRIMARY KEY,
      reservation_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'admin',
      outcome TEXT NOT NULL,
      detail JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS aae_res ON admin_action_events (reservation_id, created_at DESC)
  `;
  schemaReady = true;
}

/** Record an admin action. Best-effort — logs and swallows failures. */
export async function recordAdminAction(ev: AdminActionEvent): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO admin_action_events (reservation_id, action, actor, outcome, detail, error)
      VALUES (
        ${ev.reservationId}, ${ev.action}, ${ev.actor ?? "admin"}, ${ev.outcome},
        ${ev.detail === undefined ? null : JSON.stringify(ev.detail)}, ${ev.error ?? null}
      )
    `;
  } catch (err) {
    console.error(
      `[reservations-admin/audit] record failed res=${ev.reservationId} action=${ev.action}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToAction(r: any): AdminActionRow {
  return {
    id: r.id,
    reservationId: r.reservation_id,
    action: r.action,
    actor: r.actor,
    outcome: r.outcome,
    detail: r.detail,
    error: r.error,
    createdAt: r.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Admin actions for a set of reservation ids (a money group), newest first. */
export async function listAdminActions(
  reservationIds: number[],
  limit = 100,
): Promise<AdminActionRow[]> {
  if (!isDbConfigured() || reservationIds.length === 0) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM admin_action_events
      WHERE reservation_id = ANY(${reservationIds})
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToAction);
  } catch {
    return [];
  }
}
