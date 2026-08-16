import { sql, isDbConfigured } from "@/lib/db";

/**
 * The signature IMAGE itself, kept in Neon.
 *
 * Why this exists (owner 2026-08-08, from the W57821 investigation):
 *   BMI is the only place a signature has ever lived. Pandora answers
 *   `POST /bmi/waiver` with 201 + a waiverID, and after that the image is gone
 *   from our side forever — there is NO read-back endpoint on Pandora or Office
 *   (22 paths probed, every one 404). So when staff report "the signature never
 *   reached the profile" we can confirm a waiver RECORD exists (waiverExpiry)
 *   but cannot confirm, deny, re-push, or produce the IMAGE. For a legal record
 *   backing chargeback evidence, that is the wrong place to be.
 *
 * This is the CLAUDE.md rule applied to the signature: guest-provided data we
 * send to an external API must land in our own DB at capture, FIRST, never
 * best-effort after the call. `waiver_sign_attempts` already records what we
 * sent ABOUT the signature (bytes, outcome, waiverID); this records the
 * signature.
 *
 * Ordering contract: `storeWaiverSignature` is awaited BEFORE the Pandora POST,
 * so a signature exists on our side even if Pandora never answers. Its errors
 * are swallowed — a full disk must never cost a guest their waiver — but the
 * attempt is unconditional, which is what "guaranteed first step" means here.
 */

export interface StoreWaiverSignatureInput {
  /** Subject of the waiver (the minor, when a guardian signs). */
  personId: string;
  /** Who actually signed. Equals personId on a self-sign. */
  signerPersonId: string;
  waiverContentId: string;
  locationId: string;
  invalidationDate: string;
  /** Raw base64 PNG — NO `data:image/png;base64,` prefix. */
  signatureBase64: string;
  /** Decoded size, so a row is still meaningful if the image is rejected. */
  signatureBytes: number;
}

/** Refuse absurd payloads rather than bloat the table. A canvas signature is
 *  8–60 KB; anything past this is not a signature and we keep the metadata row
 *  instead, with `signature_png` left NULL and the reason recorded. */
const MAX_STORED_BYTES = 5 * 1024 * 1024;

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS waiver_signatures (
      id                BIGSERIAL PRIMARY KEY,
      ts                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      person_id         TEXT NOT NULL,
      signer_person_id  TEXT NOT NULL,
      waiver_content_id TEXT NOT NULL,
      location_id       TEXT NOT NULL,
      invalidation_date TEXT,
      /* base64 PNG, no data: prefix. NULL only when the payload was rejected. */
      signature_png     TEXT,
      signature_bytes   INTEGER NOT NULL DEFAULT 0,
      rejected_reason   TEXT,
      /* NULL until Pandora answers — a row that stays NULL is a signature we
         captured and never confirmed, which is exactly what we want visible. */
      outcome           TEXT,
      waiver_id         TEXT,
      settled_at        TIMESTAMPTZ
    )
  `;
  /** WHICH transport is carrying this push — "vercel-queue" or "neon-cron".
   *  Recorded so the admin board can show a waiver push that no longer has a
   *  `bmi_sync_queue` row to be seen through (owner 2026-08-13). */
  await q`ALTER TABLE waiver_signatures ADD COLUMN IF NOT EXISTS push_transport TEXT`;
  /** WHY a settled row ended the way it did — the refusing side's own words.
   *  Additive, per the migration rule above: `CREATE TABLE IF NOT EXISTS` is a
   *  no-op on a live table, so a column added to the definition alone never
   *  reaches production and every read of it errors. */
  await q`ALTER TABLE waiver_signatures ADD COLUMN IF NOT EXISTS last_error TEXT`;
  await q`CREATE INDEX IF NOT EXISTS waiver_sig_person_idx ON waiver_signatures(person_id, ts DESC)`;
  // "which signatures did we capture but never confirm landed" — the sweep view.
  await q`CREATE INDEX IF NOT EXISTS waiver_sig_unsettled_idx ON waiver_signatures(ts DESC) WHERE outcome IS NULL`;
  schemaReady = true;
}

/**
 * Persist the signature image. Returns the row id so the outcome can be
 * attached later, or null if nothing was written. NEVER throws.
 *
 * Call this BEFORE posting to Pandora.
 */
export async function storeWaiverSignature(
  input: StoreWaiverSignatureInput,
): Promise<number | null> {
  if (!isDbConfigured()) {
    console.warn("[waiver-signature] DATABASE_URL not configured — signature NOT saved");
    return null;
  }
  try {
    await ensureSchema();
    const tooBig = input.signatureBytes > MAX_STORED_BYTES;
    const empty = input.signatureBytes === 0;
    const rejected = tooBig
      ? `oversize ${input.signatureBytes}B > ${MAX_STORED_BYTES}B`
      : empty
        ? "empty signature payload"
        : null;
    const q = sql();
    const rows = (await q`
      INSERT INTO waiver_signatures (
        person_id, signer_person_id, waiver_content_id, location_id,
        invalidation_date, signature_png, signature_bytes, rejected_reason
      ) VALUES (
        ${String(input.personId)}, ${String(input.signerPersonId)},
        ${String(input.waiverContentId)}, ${input.locationId},
        ${input.invalidationDate || null},
        ${rejected ? null : input.signatureBase64},
        ${input.signatureBytes}, ${rejected}
      )
      RETURNING id
    `) as unknown as Array<{ id: number | string }>;
    const id = rows?.[0]?.id;
    if (rejected) {
      console.warn(
        `[waiver-signature] person=${input.personId} image NOT stored (${rejected}) — metadata row ${id} written`,
      );
    }
    return id === undefined || id === null ? null : Number(id);
  } catch (err) {
    console.error(
      `[waiver-signature] store failed (person=${input.personId}, ${input.signatureBytes}B):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Record what Pandora ultimately said about a stored signature. Never throws.
 *
 * `detail` is WHY, in the words of whatever refused it, and it is the difference
 * between a board a human can act on and one that just says something went wrong.
 * Before it existed, every `failed` row rendered as the same fixed sentence while
 * the real reason went to a `console.error` nobody reads — so on 2026-08-15 a
 * board full of identical-looking rows was hiding two unrelated causes (a false
 * cross-server verdict, and Naples guests carrying Fort Myers person ids). The
 * `bmi_sync_queue` rows carried their reason and were diagnosable in minutes;
 * these were not. Store it next to the outcome that needs explaining.
 */
export async function settleWaiverSignature(
  rowId: number | null,
  outcome: string,
  waiverId: string | null,
  detail?: string | null,
): Promise<void> {
  if (rowId === null || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE waiver_signatures
      SET outcome = ${outcome}, waiver_id = ${waiverId}, settled_at = NOW(),
          last_error = ${detail ? String(detail).slice(0, 500) : null}
      WHERE id = ${rowId}
    `;
  } catch (err) {
    console.error(
      `[waiver-signature] settle failed (row=${rowId} outcome=${outcome}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

export interface StoredWaiverSignature {
  id: number;
  ts: string;
  personId: string;
  signerPersonId: string;
  waiverContentId: string;
  locationId: string;
  invalidationDate: string | null;
  signatureBytes: number;
  rejectedReason: string | null;
  outcome: string | null;
  waiverId: string | null;
  /** base64 PNG, or null when the image was rejected. */
  signatureBase64: string | null;
  /** "vercel-queue" | "neon-cron" | null (filed inline, no transport needed). */
  pushTransport: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toStored(r: any): StoredWaiverSignature {
  return {
    id: Number(r.id),
    ts: String(r.ts),
    personId: String(r.person_id),
    signerPersonId: String(r.signer_person_id),
    waiverContentId: String(r.waiver_content_id),
    locationId: String(r.location_id),
    invalidationDate: r.invalidation_date ?? null,
    signatureBytes: Number(r.signature_bytes ?? 0),
    rejectedReason: r.rejected_reason ?? null,
    outcome: r.outcome ?? null,
    waiverId: r.waiver_id ?? null,
    signatureBase64: r.signature_png ?? null,
    pushTransport: r.push_transport ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Every signature we hold for a person, newest first. `withImage: false` omits
 * the base64 blob — use it for listings, which would otherwise pull megabytes.
 */
export async function listWaiverSignatures(
  personId: string,
  opts: { withImage?: boolean; limit?: number } = {},
): Promise<StoredWaiverSignature[]> {
  if (!isDbConfigured()) return [];
  const { withImage = false, limit = 20 } = opts;
  await ensureSchema();
  const q = sql();
  const lim = Math.max(1, Math.min(100, limit));
  const rows = withImage
    ? await q`
        SELECT * FROM waiver_signatures
        WHERE person_id = ${String(personId)} OR signer_person_id = ${String(personId)}
        ORDER BY ts DESC LIMIT ${lim}`
    : await q`
        SELECT id, ts, person_id, signer_person_id, waiver_content_id, location_id,
               invalidation_date, signature_bytes, rejected_reason, outcome, waiver_id,
               push_transport, NULL AS signature_png
        FROM waiver_signatures
        WHERE person_id = ${String(personId)} OR signer_person_id = ${String(personId)}
        ORDER BY ts DESC LIMIT ${lim}`;
  return (rows as unknown as unknown[]).map(toStored);
}

/**
 * Stamp which transport took the push, so a waiver that no longer has a
 * `bmi_sync_queue` row is still visible on the admin board. Best-effort: a failed
 * stamp must never affect the guest.
 */
export async function setWaiverPushTransport(id: number, transport: string): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`UPDATE waiver_signatures SET push_transport = ${transport} WHERE id = ${Number(id)}`;
  } catch (err) {
    console.warn(`[waiver-sig] could not stamp transport on row ${id}:`, err);
  }
}

/**
 * Do WE hold an unexpired signature for this person, whatever BMI thinks?
 *
 * This is the Neon half of "does this person have a waiver right now", and it
 * exists because the kiosk no longer waits for BMI. A guest signs, the push rides
 * the queue, and for the next 20-30 seconds Pandora will honestly answer "no
 * waiver" — so every consumer that reads only Pandora would tell a guest who just
 * signed to sign again. `checkRacerWaiverValid` in particular fails CLOSED by
 * design, which is right for an unverified racer and wrong for this one.
 *
 * House rule, third application tonight: our record is the source of truth and a
 * lagging downstream read may only ever ADD to it, never subtract.
 *
 * Deliberate choices:
 *   - `person_id` ONLY, never `signer_person_id`. A guardian who signed a minor's
 *     waiver does not thereby hold one of their own, and conflating the two would
 *     wave an unwaivered adult onto a kart.
 *   - `signature_png IS NOT NULL` and no `rejected_reason`: a row whose image was
 *     rejected is not a signature we can stand behind.
 *   - Outcome is NOT required. The whole point is that a captured-but-not-yet-
 *     pushed signature counts; requiring `signed` would defeat it.
 *   - `invalidation_date` is TEXT "YYYY-MM-DD", so a lexicographic compare against
 *     today is a correct date compare.
 */
export async function hasUnexpiredCapturedWaiver(personId: string): Promise<boolean> {
  if (!isDbConfigured() || !personId) return false;
  await ensureSchema();
  const today = new Date().toISOString().slice(0, 10);
  const q = sql();
  const rows = (await q`
    SELECT 1 FROM waiver_signatures
    WHERE person_id = ${String(personId)}
      AND signature_png IS NOT NULL
      AND rejected_reason IS NULL
      AND invalidation_date IS NOT NULL
      AND invalidation_date >= ${today}
    LIMIT 1
  `) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * One signature by its row id, image included.
 *
 * The queue carries this ID rather than the base64 PNG — Vercel Queues meters
 * messages in 4 KiB chunks, so a 7-40KB signature would cost several operations
 * on the send AND on every delivery, and it would put guest data on a message bus
 * for no reason. The row is already durable in Neon before anything is sent, so
 * the id is all the consumer needs.
 *
 * By ID, never "latest for this person": a guest who signs twice in a visit has
 * two rows, and the push must file the one that was actually captured for it.
 */
export async function getWaiverSignatureById(id: number): Promise<StoredWaiverSignature | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM waiver_signatures WHERE id = ${Number(id)} LIMIT 1
  `) as unknown as unknown[];
  return rows[0] ? toStored(rows[0]) : null;
}

/** The newest signature image we hold for a person, or null. */
export async function getLatestWaiverSignature(
  personId: string,
): Promise<StoredWaiverSignature | null> {
  const rows = await listWaiverSignatures(personId, { withImage: true, limit: 1 });
  return rows.find((r) => r.signatureBase64) ?? rows[0] ?? null;
}
