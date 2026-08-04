/**
 * Kiosk check-in records (Neon) — the durable record of "this party checked in
 * at the kiosk for reservation X, and here's who bound to what".
 *
 * HOUSE HARD RULE: guest input persists HERE first, before (and regardless of)
 * any BMI / QAMF / Pandora write. An external-API failure must never lose the
 * check-in; every downstream sync records its own status column here, and a
 * sweep retries the ones that failed. The event row is the check-in's identity
 * and the pipeline's idempotency anchor — written at VERIFY time, one per
 * (bill_id, business_date), never on an anonymous browse view.
 *
 * Raw SQL via @/lib/db (no ORM — house rule). Self-creating schema, matching
 * the kiosk-waiver-joins-db / kiosk-devices-db pattern. BMI ids are 17-digit
 * strings and stay TEXT end-to-end — never Number() them.
 */
import { sql, isDbConfigured } from "@/lib/db";

/** How the guest proved the reservation was theirs. Stored as plain TEXT (no
 *  CHECK constraint), so adding a value needs no migration — but keep it in
 *  lockstep with `CheckinVerifiedVia` in ../checkin/types.ts, which is the
 *  wire-side twin and where each value is explained. */
export type VerifiedVia = "code" | "qr" | "otp" | "browse-otp" | "test-bypass" | "racer";
export type BmiStateStatus = "pending" | "set" | "failed";
export type PersonAttachStatus = "pending" | "attached" | "failed" | "skipped";
export type ScheduleStatus = "pending" | "inserted" | "already_linked" | "failed" | "n/a";
export type QamfStatus = "pending" | "synced" | "failed" | "n/a";

export interface KioskCheckinEventRow {
  id: number;
  billId: string;
  projectId: string | null;
  locationId: number | null;
  neonReservationIds: number[];
  center: string;
  kioskId: string | null;
  verifiedVia: VerifiedVia;
  businessDate: string;
  completedAt: string | null;
  bmiStateStatus: BmiStateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface KioskCheckinPersonRow {
  id: number;
  eventId: number;
  /** Stable per-party idempotency key (personId ?? pandoraPersonId ?? a
   *  client-stable local id) — NEVER null, so re-runs upsert instead of
   *  duplicating (a nullable person_id would treat every walk-in as distinct). */
  slotKey: string;
  /** 17-digit BMI Office id — what registerProjectPerson takes. */
  personId: string | null;
  /** SHORT Pandora id — the only id /bmi/schedule + waiver-sign accept. */
  pandoraPersonId: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  waiverValid: boolean;
  /** Heat rows this person was bound to (heatId/track/tier/category/productId). */
  boundHeats: unknown;
  boundAttractionSlugs: string[];
  bowlingSlot: number | null;
  bmiAttachStatus: PersonAttachStatus;
  scheduleStatus: ScheduleStatus;
  qamfStatus: QamfStatus;
  errors: unknown;
  createdAt: string;
  updatedAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_checkin_events (
      id                   BIGSERIAL PRIMARY KEY,
      bill_id              TEXT NOT NULL,
      project_id           TEXT,
      location_id          INTEGER,
      neon_reservation_ids BIGINT[] NOT NULL DEFAULT '{}',
      center               TEXT NOT NULL,
      kiosk_id             TEXT,
      verified_via         TEXT NOT NULL,
      business_date        DATE NOT NULL,
      completed_at         TIMESTAMPTZ,
      bmi_state_status     TEXT NOT NULL DEFAULT 'pending',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (bill_id, business_date)
    )
  `;
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_checkin_people (
      id                     BIGSERIAL PRIMARY KEY,
      event_id               BIGINT NOT NULL REFERENCES kiosk_checkin_events(id) ON DELETE CASCADE,
      slot_key               TEXT NOT NULL,
      person_id              TEXT,
      pandora_person_id      TEXT,
      display_name           TEXT NOT NULL,
      first_name             TEXT,
      last_name              TEXT,
      waiver_valid           BOOLEAN NOT NULL DEFAULT false,
      bound_heats            JSONB,
      bound_attraction_slugs TEXT[] NOT NULL DEFAULT '{}',
      bowling_slot           INTEGER,
      bmi_attach_status      TEXT NOT NULL DEFAULT 'pending',
      schedule_status        TEXT NOT NULL DEFAULT 'n/a',
      qamf_status            TEXT NOT NULL DEFAULT 'n/a',
      errors                 JSONB,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (event_id, slot_key)
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_checkin_events_bill_idx
    ON kiosk_checkin_events (bill_id)
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_checkin_people_event_idx
    ON kiosk_checkin_people (event_id)
  `;
  schemaReady = true;
}

function mapEvent(r: Record<string, unknown>): KioskCheckinEventRow {
  return {
    id: Number(r.id),
    billId: String(r.bill_id),
    projectId: r.project_id === null ? null : String(r.project_id),
    locationId: r.location_id === null ? null : Number(r.location_id),
    neonReservationIds: Array.isArray(r.neon_reservation_ids)
      ? (r.neon_reservation_ids as unknown[]).map((v) => Number(v))
      : [],
    center: String(r.center),
    kioskId: r.kiosk_id === null ? null : String(r.kiosk_id),
    verifiedVia: String(r.verified_via) as VerifiedVia,
    businessDate: String(r.business_date),
    completedAt: r.completed_at === null ? null : String(r.completed_at),
    bmiStateStatus: String(r.bmi_state_status) as BmiStateStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapPerson(r: Record<string, unknown>): KioskCheckinPersonRow {
  return {
    id: Number(r.id),
    eventId: Number(r.event_id),
    slotKey: String(r.slot_key),
    personId: r.person_id === null ? null : String(r.person_id),
    pandoraPersonId: r.pandora_person_id === null ? null : String(r.pandora_person_id),
    displayName: String(r.display_name),
    firstName: r.first_name === null ? null : String(r.first_name),
    lastName: r.last_name === null ? null : String(r.last_name),
    waiverValid: r.waiver_valid === true,
    boundHeats: r.bound_heats ?? null,
    boundAttractionSlugs: Array.isArray(r.bound_attraction_slugs)
      ? (r.bound_attraction_slugs as unknown[]).map((v) => String(v))
      : [],
    bowlingSlot: r.bowling_slot === null ? null : Number(r.bowling_slot),
    bmiAttachStatus: String(r.bmi_attach_status) as PersonAttachStatus,
    scheduleStatus: String(r.schedule_status) as ScheduleStatus,
    qamfStatus: String(r.qamf_status) as QamfStatus,
    errors: r.errors ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Open (or return the existing) check-in event for this bill + business day.
 * Called at VERIFY time — the reservation has been found and the guest proved
 * possession (code/QR/OTP). Idempotent on (bill_id, business_date): a second
 * kiosk, a reload, or a retried verify returns the SAME event id, which is what
 * the /complete pipeline keys its idempotency on. Never downgrades a completed
 * event back to pending.
 */
export async function openCheckinEvent(args: {
  billId: string;
  projectId?: string | null;
  locationId?: number | null;
  neonReservationIds?: number[];
  center: string;
  kioskId?: string | null;
  verifiedVia: VerifiedVia;
  businessDate: string;
}): Promise<KioskCheckinEventRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO kiosk_checkin_events
      (bill_id, project_id, location_id, neon_reservation_ids, center, kiosk_id,
       verified_via, business_date)
    VALUES
      (${args.billId}, ${args.projectId ?? null}, ${args.locationId ?? null},
       ${args.neonReservationIds ?? []}, ${args.center}, ${args.kioskId ?? null},
       ${args.verifiedVia}, ${args.businessDate})
    ON CONFLICT (bill_id, business_date) DO UPDATE SET
      project_id  = COALESCE(EXCLUDED.project_id, kiosk_checkin_events.project_id),
      location_id = COALESCE(EXCLUDED.location_id, kiosk_checkin_events.location_id),
      neon_reservation_ids = CASE
        WHEN array_length(EXCLUDED.neon_reservation_ids, 1) IS NULL
          THEN kiosk_checkin_events.neon_reservation_ids
        ELSE EXCLUDED.neon_reservation_ids END,
      kiosk_id    = COALESCE(EXCLUDED.kiosk_id, kiosk_checkin_events.kiosk_id),
      updated_at  = now()
    RETURNING *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? mapEvent(rows[0]) : null;
}

export async function getCheckinEvent(
  billId: string,
  businessDate: string,
): Promise<KioskCheckinEventRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM kiosk_checkin_events
    WHERE bill_id = ${billId} AND business_date = ${businessDate}
  `) as Array<Record<string, unknown>>;
  return rows[0] ? mapEvent(rows[0]) : null;
}

/** Mark the event complete (the /complete pipeline's terminal step). */
export async function completeCheckinEvent(
  eventId: number,
  bmiStateStatus: BmiStateStatus,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE kiosk_checkin_events
    SET completed_at = now(), bmi_state_status = ${bmiStateStatus}, updated_at = now()
    WHERE id = ${eventId}
  `;
}

export async function listCheckinPeople(eventId: number): Promise<KioskCheckinPersonRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM kiosk_checkin_people
    WHERE event_id = ${eventId}
    ORDER BY created_at
  `) as Array<Record<string, unknown>>;
  return rows.map(mapPerson);
}

/**
 * Persist a bound person (step 1 of the join/complete pipeline — before any
 * vendor call). Idempotent per (event_id, person_id): re-runs refresh the
 * binding + short id but never downgrade a succeeded vendor status.
 *
 * waiver_valid is STICKY-TRUE within the event: callers that only refresh the
 * binding (the heat-assignment upsert passes no waiverValid) used to reset the
 * true the bind wrote back to the `?? false` default, so our durable record
 * said "no waiver" for people with valid waivers (2026-07-31 whitley check-in).
 * A waiver can't be revoked mid-visit, and the event row is scoped to one
 * business date — once true, it stays true.
 */
export async function upsertCheckinPerson(args: {
  eventId: number;
  /** REQUIRED stable idempotency key — personId ?? pandoraPersonId ?? local id. */
  slotKey: string;
  personId?: string | null;
  pandoraPersonId?: string | null;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  waiverValid?: boolean;
  boundHeats?: unknown;
  boundAttractionSlugs?: string[];
  bowlingSlot?: number | null;
}): Promise<KioskCheckinPersonRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO kiosk_checkin_people
      (event_id, slot_key, person_id, pandora_person_id, display_name, first_name, last_name,
       waiver_valid, bound_heats, bound_attraction_slugs, bowling_slot)
    VALUES
      (${args.eventId}, ${args.slotKey}, ${args.personId ?? null}, ${args.pandoraPersonId ?? null},
       ${args.displayName}, ${args.firstName ?? null}, ${args.lastName ?? null},
       ${args.waiverValid ?? false},
       ${args.boundHeats === undefined ? null : JSON.stringify(args.boundHeats)}::jsonb,
       ${args.boundAttractionSlugs ?? []}, ${args.bowlingSlot ?? null})
    ON CONFLICT (event_id, slot_key) DO UPDATE SET
      person_id = COALESCE(EXCLUDED.person_id, kiosk_checkin_people.person_id),
      pandora_person_id = COALESCE(EXCLUDED.pandora_person_id, kiosk_checkin_people.pandora_person_id),
      display_name = EXCLUDED.display_name,
      first_name = COALESCE(EXCLUDED.first_name, kiosk_checkin_people.first_name),
      last_name = COALESCE(EXCLUDED.last_name, kiosk_checkin_people.last_name),
      waiver_valid = (kiosk_checkin_people.waiver_valid OR EXCLUDED.waiver_valid),
      bound_heats = COALESCE(EXCLUDED.bound_heats, kiosk_checkin_people.bound_heats),
      bound_attraction_slugs = EXCLUDED.bound_attraction_slugs,
      bowling_slot = COALESCE(EXCLUDED.bowling_slot, kiosk_checkin_people.bowling_slot),
      updated_at = now()
    RETURNING *
  `) as Array<Record<string, unknown>>;
  return rows[0] ? mapPerson(rows[0]) : null;
}

/** Record a downstream sync outcome on a person row (PR2/PR3 pipeline). */
export async function setCheckinPersonStatus(
  personRowId: number,
  patch: {
    pandoraPersonId?: string | null;
    bmiAttachStatus?: PersonAttachStatus;
    scheduleStatus?: ScheduleStatus;
    qamfStatus?: QamfStatus;
    error?: { step: string; message: string } | null;
  },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE kiosk_checkin_people
    SET pandora_person_id = COALESCE(${patch.pandoraPersonId ?? null}, pandora_person_id),
        bmi_attach_status = COALESCE(${patch.bmiAttachStatus ?? null}, bmi_attach_status),
        schedule_status   = COALESCE(${patch.scheduleStatus ?? null}, schedule_status),
        qamf_status       = COALESCE(${patch.qamfStatus ?? null}, qamf_status),
        errors = CASE WHEN ${patch.error ? JSON.stringify(patch.error) : null}::jsonb IS NULL
          THEN errors ELSE ${patch.error ? JSON.stringify(patch.error) : null}::jsonb END,
        updated_at = now()
    WHERE id = ${personRowId}
  `;
}

/** Rows whose racer→session schedule POST still needs a retry (PR2 sweep). */
export async function listPendingScheduleRows(limit = 200): Promise<KioskCheckinPersonRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT p.* FROM kiosk_checkin_people p
    WHERE p.schedule_status IN ('pending', 'failed')
    ORDER BY p.updated_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapPerson);
}
