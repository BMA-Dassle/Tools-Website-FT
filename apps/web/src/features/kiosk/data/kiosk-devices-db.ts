/**
 * Kiosk device registry (Neon) — durable per-device provisioning.
 *
 * A kiosk saves its full config to BOTH localStorage (fast boot,
 * offline-tolerant) and here. After a reimage / browser reset / new machine
 * at the same spot, the kiosk pulls its previous setup by kioskId
 * (`<center>:<kioskNumber>`) so staff don't re-provision from scratch.
 *
 * Raw SQL via @/lib/db (no ORM — house rule). Self-creating schema, matching
 * the bowling-db pattern.
 */
import { sql, isDbConfigured } from "@/lib/db";

export interface KioskDeviceRow {
  kioskId: string;
  center: string;
  kioskNumber: number;
  brand: string;
  config: Record<string, unknown>;
  updatedAt: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kiosk_devices (
      kiosk_id      TEXT PRIMARY KEY,
      center        TEXT NOT NULL,
      kiosk_number  INTEGER NOT NULL DEFAULT 1,
      brand         TEXT NOT NULL,
      config        JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  schemaReady = true;
}

/** Upsert the full device config (called from the admin save + on reserve boot). */
export async function saveKioskDevice(args: {
  kioskId: string;
  center: string;
  kioskNumber: number;
  brand: string;
  config: Record<string, unknown>;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO kiosk_devices (kiosk_id, center, kiosk_number, brand, config, updated_at)
    VALUES (${args.kioskId}, ${args.center}, ${args.kioskNumber}, ${args.brand},
            ${JSON.stringify(args.config)}::jsonb, now())
    ON CONFLICT (kiosk_id) DO UPDATE SET
      center = EXCLUDED.center,
      kiosk_number = EXCLUDED.kiosk_number,
      brand = EXCLUDED.brand,
      config = EXCLUDED.config,
      updated_at = now()
  `;
}

/**
 * Merge just the reader-location hints (port index / baud / USB info) into an
 * existing device's config. Non-PII device layout, so this is callable WITHOUT
 * the admin PIN — the guest dispenser flow (which has no admin auth) can save
 * "where I found the CRT-591" to Neon, so a fresh boot connects straight to it
 * instead of re-scanning. Only touches these three fields; never creates a row.
 */
export async function saveKioskReaderHint(
  kioskId: string,
  hint: {
    cardReaderPortIndex?: number;
    cardReaderBaud?: number;
    cardReaderPortInfo?: { usbVendorId?: number; usbProductId?: number } | null;
  },
): Promise<boolean> {
  if (!isDbConfigured()) return false;
  const row = await loadKioskDevice(kioskId);
  if (!row) return false;
  const config = { ...row.config, ...hint };
  await saveKioskDevice({
    kioskId,
    center: row.center,
    kioskNumber: row.kioskNumber,
    brand: row.brand,
    config,
  });
  return true;
}

/** Pull a saved device config by kioskId (fallback when localStorage is empty). */
export async function loadKioskDevice(kioskId: string): Promise<KioskDeviceRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const query = (id: string) =>
    q`
      SELECT kiosk_id, center, kiosk_number, brand, config, updated_at
      FROM kiosk_devices WHERE kiosk_id = ${id} LIMIT 1
    ` as unknown as Promise<Array<Record<string, unknown>>>;
  let rows = await query(kioskId);
  // Legacy fallback: keys used to be `<center>:<number>` (e.g. `naples:3`)
  // before the venue-slug scheme. Only Naples is unambiguous (HPN ⇒ naples);
  // a Fort Myers `<center>:<number>` can't tell FT from HPFM, so we never guess
  // it (that ambiguity is the very collision we're fixing) — re-save those once
  // through admin to write the new `FT:`/`HPFM:` key.
  if (!rows[0]) {
    const [slug, num] = kioskId.split(":");
    if (slug === "HPN" && num) rows = await query(`naples:${num}`);
  }
  const r = rows[0];
  if (!r) return null;
  return {
    kioskId: String(r.kiosk_id),
    center: String(r.center),
    kioskNumber: Number(r.kiosk_number),
    brand: String(r.brand),
    config: (r.config as Record<string, unknown>) ?? {},
    updatedAt: String(r.updated_at),
  };
}

/** List every provisioned kiosk (admin overview). */
export async function listKioskDevices(): Promise<KioskDeviceRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT kiosk_id, center, kiosk_number, brand, config, updated_at
    FROM kiosk_devices ORDER BY center, kiosk_number
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    kioskId: String(r.kiosk_id),
    center: String(r.center),
    kioskNumber: Number(r.kiosk_number),
    brand: String(r.brand),
    config: (r.config as Record<string, unknown>) ?? {},
    updatedAt: String(r.updated_at),
  }));
}
