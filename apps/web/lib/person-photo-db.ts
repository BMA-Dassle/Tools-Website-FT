/**
 * Kiosk guest-photo QUEUE (persist-first doctrine): the waiver-time photo a
 * guest gives us is data we send to BMI (Pandora POST /bmi/person/picture), so
 * it MUST be durable in OUR DB before/independent of the upstream call. Rows
 * hold the PNG bytes only until Pandora confirms — then the blob is cleared
 * (queue, not an archive; the photo's home is BMI). A sweep retries pending
 * rows so a Pandora blip never loses a captured photo.
 *
 * personId is a raw BMI id string — NEVER Number() it (BMI ID precision rule).
 */
import { sql, isDbConfigured } from "@/lib/db";

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_person_photos (
      id          SERIAL PRIMARY KEY,
      person_id   TEXT NOT NULL,
      location_id TEXT NOT NULL,
      png         BYTEA,
      bytes       INTEGER NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      uploaded_at TIMESTAMPTZ,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS kpp_pending ON kiosk_person_photos(created_at) WHERE uploaded_at IS NULL`;
  ensured = true;
}

export interface PendingPersonPhoto {
  id: number;
  personId: string;
  locationId: string;
  png: Buffer | null;
  attempts: number;
}

/** Persist the captured photo BEFORE any Pandora attempt. Throws if DB down —
 *  the route surfaces that (we never pretend a photo is safe when it isn't). */
export async function insertPersonPhoto(args: {
  personId: string;
  locationId: string;
  png: Buffer;
}): Promise<number> {
  if (!isDbConfigured()) throw new Error("DB not configured");
  await ensureTable();
  const q = sql();
  const rows = (await q`
    INSERT INTO kiosk_person_photos (person_id, location_id, png, bytes)
    VALUES (${args.personId}, ${args.locationId}, ${args.png}, ${args.png.length})
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/** Pandora confirmed — clear the blob (BMI now owns the photo), keep the row for audit. */
export async function markPersonPhotoUploaded(id: number): Promise<void> {
  const q = sql();
  await q`
    UPDATE kiosk_person_photos
    SET uploaded_at = NOW(), png = NULL, last_error = NULL
    WHERE id = ${id}
  `;
}

export async function bumpPersonPhotoAttempt(id: number, error: string): Promise<void> {
  const q = sql();
  await q`
    UPDATE kiosk_person_photos
    SET attempts = attempts + 1, last_error = ${error.slice(0, 500)}
    WHERE id = ${id}
  `;
}

/** Pending rows for the retry sweep (oldest first, capped attempts). */
export async function getPendingPersonPhotos(limit = 10): Promise<PendingPersonPhoto[]> {
  if (!isDbConfigured()) return [];
  await ensureTable();
  const q = sql();
  const rows = (await q`
    SELECT id, person_id, location_id, png, attempts
    FROM kiosk_person_photos
    WHERE uploaded_at IS NULL AND png IS NOT NULL AND attempts < 10
    ORDER BY created_at ASC
    LIMIT ${limit}
  `) as Array<{
    id: number;
    person_id: string;
    location_id: string;
    png: Buffer | null;
    attempts: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    locationId: r.location_id,
    png: r.png,
    attempts: r.attempts,
  }));
}
