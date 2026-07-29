/**
 * Signed in-house waivers (Neon) — OUR system of record for a signed waiver, the
 * artifact that until now existed only inside BMI. Written when a guest signs
 * while `kioskWaiverInhouseEnabled()` is on.
 *
 * HOUSE HARD RULE: the signed waiver persists HERE first, unconditionally, before
 * the BMI dual-write (so a BMI/Azure failure never loses the signed legal record).
 * BMI sync status is then recorded on the row for staff reconciliation, exactly
 * like kiosk_waiver_joins.bmi_attach_status.
 *
 * Raw SQL via @/lib/db (no ORM). Self-creating schema. BMI person/waiver ids are
 * 17-digit strings — TEXT end-to-end, never Number() them. The signature PNG is
 * stored as a base64 data string (Phase 1; a blob-store URL is a later swap).
 */
import { sql, isDbConfigured } from "@/lib/db";
import type { WaiverLang, WaiverVariant } from "../waiver/templates";

export type WaiverBmiSyncStatus = "pending" | "synced" | "failed" | "skipped";

export interface SignedWaiverRow {
  id: number;
  personId: string;
  signerPersonId: string;
  variant: WaiverVariant;
  lang: WaiverLang;
  templateVersion: string;
  location: string | null;
  signedAt: string;
  expiresAt: string;
  bmiWaiverId: string | null;
  bmiSyncStatus: WaiverBmiSyncStatus;
  bmiSyncError: string | null;
  createdAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_waivers (
      id                BIGSERIAL PRIMARY KEY,
      person_id         TEXT NOT NULL,
      signer_person_id  TEXT NOT NULL,
      variant           TEXT NOT NULL,
      lang              TEXT NOT NULL,
      template_version  TEXT NOT NULL,
      location          TEXT,
      signature_png     TEXT NOT NULL,
      signed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at        TIMESTAMPTZ NOT NULL,
      bmi_waiver_id     TEXT,
      bmi_sync_status   TEXT NOT NULL DEFAULT 'pending',
      bmi_sync_error    TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS kiosk_waivers_person_idx
    ON kiosk_waivers (person_id)
  `;
  schemaReady = true;
}

function mapRow(r: Record<string, unknown>): SignedWaiverRow {
  return {
    id: Number(r.id),
    personId: String(r.person_id),
    signerPersonId: String(r.signer_person_id),
    variant: String(r.variant) as WaiverVariant,
    lang: String(r.lang) as WaiverLang,
    templateVersion: String(r.template_version),
    location: r.location === null ? null : String(r.location),
    signedAt: String(r.signed_at),
    expiresAt: String(r.expires_at),
    bmiWaiverId: r.bmi_waiver_id === null ? null : String(r.bmi_waiver_id),
    bmiSyncStatus: String(r.bmi_sync_status) as WaiverBmiSyncStatus,
    bmiSyncError: r.bmi_sync_error === null ? null : String(r.bmi_sync_error),
    createdAt: String(r.created_at),
  };
}

/** Persist the signed waiver (step 1 of the sign route — before any BMI call). */
export async function insertSignedWaiver(args: {
  personId: string;
  signerPersonId: string;
  variant: WaiverVariant;
  lang: WaiverLang;
  templateVersion: string;
  location?: string | null;
  /** base64 PNG (no data: prefix needed; stored as-is). */
  signaturePng: string;
  expiresAt: Date;
}): Promise<SignedWaiverRow> {
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    INSERT INTO kiosk_waivers
      (person_id, signer_person_id, variant, lang, template_version, location,
       signature_png, expires_at)
    VALUES
      (${args.personId}, ${args.signerPersonId}, ${args.variant}, ${args.lang},
       ${args.templateVersion}, ${args.location ?? null}, ${args.signaturePng},
       ${args.expiresAt.toISOString()})
    RETURNING id, person_id, signer_person_id, variant, lang, template_version,
              location, signed_at, expires_at, bmi_waiver_id, bmi_sync_status,
              bmi_sync_error, created_at
  `) as Array<Record<string, unknown>>;
  return mapRow(rows[0]);
}

/** Record the BMI dual-write outcome for staff reconciliation. */
export async function setWaiverBmiSync(
  id: number,
  status: WaiverBmiSyncStatus,
  opts?: { waiverId?: string | null; error?: string | null },
): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE kiosk_waivers
    SET bmi_sync_status = ${status},
        bmi_waiver_id = ${opts?.waiverId ?? null},
        bmi_sync_error = ${opts?.error ?? null}
    WHERE id = ${id}
  `;
}

/** Latest non-expired signed waiver for a person — our own validity source
 *  (Phase 2 will let the validity-derivation points read this Neon-first). */
export async function latestValidWaiver(personId: string): Promise<SignedWaiverRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, person_id, signer_person_id, variant, lang, template_version,
           location, signed_at, expires_at, bmi_waiver_id, bmi_sync_status,
           bmi_sync_error, created_at
    FROM kiosk_waivers
    WHERE person_id = ${personId} AND expires_at > now()
    ORDER BY signed_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : null;
}

/** BMI-sync failures for staff reconciliation / a retry sweep. */
export async function listUnsyncedWaivers(limit = 100): Promise<SignedWaiverRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, person_id, signer_person_id, variant, lang, template_version,
           location, signed_at, expires_at, bmi_waiver_id, bmi_sync_status,
           bmi_sync_error, created_at
    FROM kiosk_waivers
    WHERE bmi_sync_status = 'failed'
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}
