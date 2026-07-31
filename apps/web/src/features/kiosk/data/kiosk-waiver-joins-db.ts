/**
 * Kiosk group-waiver joins (Neon) — the durable record of "this person signed
 * on at the kiosk as part of reservation X".
 *
 * HOUSE HARD RULE: guest input persists HERE first, before (and regardless of)
 * the BMI registerProjectPerson attach — an external-API failure must never
 * lose the join. The roster route unions these rows with BMI projectPersons,
 * so a guest whose attach failed still shows up on the kiosk roster.
 *
 * Raw SQL via @/lib/db (no ORM — house rule). Self-creating schema, matching
 * the kiosk-devices-db / bowling-db pattern. BMI ids are 17-digit strings and
 * stay TEXT end-to-end — never Number() them.
 */
import { sql, isDbConfigured } from "@/lib/db";

export type BmiAttachStatus = "pending" | "attached" | "failed" | "skipped";

export interface KioskWaiverJoinRow {
  id: number;
  projectId: string;
  locationId: number;
  personId: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  kioskId: string | null;
  bmiAttachStatus: BmiAttachStatus;
  bmiAttachError: string | null;
  createdAt: string;
  updatedAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_waiver_joins (
      id                BIGSERIAL PRIMARY KEY,
      project_id        TEXT NOT NULL,
      location_id       INTEGER NOT NULL,
      person_id         TEXT NOT NULL,
      display_name      TEXT NOT NULL,
      first_name        TEXT,
      last_name         TEXT,
      kiosk_id          TEXT,
      bmi_attach_status TEXT NOT NULL DEFAULT 'pending',
      bmi_attach_error  TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, person_id)
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_waiver_joins_project_idx
    ON kiosk_waiver_joins (project_id)
  `;
  schemaReady = true;
}

function mapRow(r: Record<string, unknown>): KioskWaiverJoinRow {
  return {
    id: Number(r.id),
    projectId: String(r.project_id),
    locationId: Number(r.location_id),
    personId: String(r.person_id),
    displayName: String(r.display_name),
    firstName: r.first_name === null ? null : String(r.first_name),
    lastName: r.last_name === null ? null : String(r.last_name),
    kioskId: r.kiosk_id === null ? null : String(r.kiosk_id),
    bmiAttachStatus: String(r.bmi_attach_status) as BmiAttachStatus,
    bmiAttachError: r.bmi_attach_error === null ? null : String(r.bmi_attach_error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Persist the join (step 1 of the join route — before any BMI call). Re-joins
 * are idempotent: the (project_id, person_id) conflict refreshes names but
 * NEVER downgrades an 'attached' status back to 'pending'.
 */
export async function upsertJoin(args: {
  projectId: string;
  locationId: number;
  personId: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  kioskId?: string | null;
}): Promise<KioskWaiverJoinRow> {
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO kiosk_waiver_joins
      (project_id, location_id, person_id, display_name, first_name, last_name, kiosk_id)
    VALUES
      (${args.projectId}, ${args.locationId}, ${args.personId}, ${args.displayName},
       ${args.firstName ?? null}, ${args.lastName ?? null}, ${args.kioskId ?? null})
    ON CONFLICT (project_id, person_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      first_name = COALESCE(EXCLUDED.first_name, kiosk_waiver_joins.first_name),
      last_name = COALESCE(EXCLUDED.last_name, kiosk_waiver_joins.last_name),
      kiosk_id = COALESCE(EXCLUDED.kiosk_id, kiosk_waiver_joins.kiosk_id),
      updated_at = now()
    RETURNING *
  `) as Array<Record<string, unknown>>;
  return mapRow(rows[0]);
}

export async function setJoinAttachStatus(
  projectId: string,
  personId: string,
  status: BmiAttachStatus,
  error?: string | null,
): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE kiosk_waiver_joins
    SET bmi_attach_status = ${status},
        bmi_attach_error = ${error ?? null},
        updated_at = now()
    WHERE project_id = ${projectId} AND person_id = ${personId}
  `;
}

export async function listJoinsForProject(projectId: string): Promise<KioskWaiverJoinRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM kiosk_waiver_joins
    WHERE project_id = ${projectId}
    ORDER BY created_at
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/**
 * Backfill candidates for the poisoned-attach sweep: honest 'failed' rows, plus
 * rows recorded 'attached' BEFORE the 2026-07-30 fix — the pre-fix attach sent
 * the projectId where BMI wanted a bill id AND read 200 {"success":false} as
 * success, so none of those "attached" rows ever reached BMI. Oldest first.
 */
export async function listAttachBackfillCandidates(args: {
  /** ISO timestamp: 'attached' rows last touched before this are suspect. */
  attachedBefore: string;
  limit: number;
}): Promise<KioskWaiverJoinRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM kiosk_waiver_joins
    WHERE bmi_attach_status = 'failed'
       OR (bmi_attach_status = 'attached' AND updated_at < ${args.attachedBefore})
    ORDER BY updated_at ASC
    LIMIT ${args.limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Attach failures for staff reconciliation / a future retry sweep. */
export async function listFailedJoins(limit = 100): Promise<KioskWaiverJoinRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM kiosk_waiver_joins
    WHERE bmi_attach_status = 'failed'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}
