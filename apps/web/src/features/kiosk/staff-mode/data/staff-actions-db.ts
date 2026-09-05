import "server-only";
import { sql, isDbConfigured } from "@ft/db";

/**
 * `kiosk_staff_actions` — the durable record of every staff override made from
 * a kiosk: WHO (employee from the signed token), on WHOM (BMI person), WHAT
 * (membership / comp, kind, term or qty, reason), WHERE (kiosk, location), and
 * how it went.
 *
 * PERSIST-FIRST (house rule, tasks/lessons.md § Persist guest input): the row is
 * written as 'pending' BEFORE the Pandora call and settled after. A crash or a
 * Pandora blip between the two leaves a 'pending' / 'failed' row with the error,
 * so nothing a staff member did is ever unrecoverable — and a comp that never
 * landed is findable rather than a mystery at the desk.
 *
 * Raw SQL via @ft/db (no ORM — house rule). person_id is TEXT: BMI ids exceed
 * Number.MAX_SAFE_INTEGER and must never be numeric anywhere.
 */

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_staff_actions (
      id             BIGSERIAL PRIMARY KEY,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      kiosk_id       TEXT,
      location       TEXT NOT NULL,
      employee_id    TEXT NOT NULL,
      employee_name  TEXT NOT NULL,
      card_tail      TEXT,
      person_id      TEXT NOT NULL,
      person_name    TEXT,
      action         TEXT NOT NULL,
      kind_key       TEXT NOT NULL,
      kind_label     TEXT NOT NULL,
      kind_id        TEXT NOT NULL,
      qty            INTEGER,
      activates      TIMESTAMPTZ,
      expires        TIMESTAMPTZ,
      reason         TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      result_id      TEXT,
      last_error     TEXT
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_staff_actions_person_idx
      ON kiosk_staff_actions (person_id, created_at DESC)
  `;
  schemaReady = true;
}

export interface StaffActionPendingInput {
  kioskId: string | null;
  location: string;
  employeeId: string;
  employeeName: string;
  cardTail: string | null;
  /** Raw BMI id string. */
  personId: string;
  personName: string | null;
  action: "membership" | "comp";
  kindKey: string;
  kindLabel: string;
  kindId: string;
  qty?: number | null;
  activates?: string | null;
  expires?: string | null;
  reason?: string | null;
}

/**
 * Write the intent. Throws when the DB is not configured — a staff override
 * with no audit row is not a write we make (the doctrine is "persistence is
 * the first guaranteed step", not "best effort").
 */
export async function recordStaffActionPending(input: StaffActionPendingInput): Promise<string> {
  if (!isDbConfigured()) {
    throw new Error("staff actions need the database (audit log) — DATABASE_URL is not set");
  }
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO kiosk_staff_actions
      (kiosk_id, location, employee_id, employee_name, card_tail, person_id, person_name,
       action, kind_key, kind_label, kind_id, qty, activates, expires, reason)
    VALUES
      (${input.kioskId}, ${input.location}, ${input.employeeId}, ${input.employeeName},
       ${input.cardTail}, ${input.personId}, ${input.personName}, ${input.action},
       ${input.kindKey}, ${input.kindLabel}, ${input.kindId}, ${input.qty ?? null},
       ${input.activates ?? null}, ${input.expires ?? null}, ${input.reason ?? null})
    RETURNING id
  `) as Array<{ id: string | number }>;
  return String(rows[0].id);
}

export async function markStaffActionDone(id: string, resultId: string): Promise<void> {
  const q = sql();
  await q`
    UPDATE kiosk_staff_actions
       SET status = 'done', result_id = ${resultId}, last_error = NULL, updated_at = now()
     WHERE id = ${id}
  `;
}

export async function markStaffActionFailed(id: string, error: string): Promise<void> {
  const q = sql();
  await q`
    UPDATE kiosk_staff_actions
       SET status = 'failed', last_error = ${error.slice(0, 500)}, updated_at = now()
     WHERE id = ${id}
  `;
}
