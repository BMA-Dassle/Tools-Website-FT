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

/**
 * Legacy-key fallback for a venue-slug kioskId with no row yet. Keys used to be
 * `<center>:<number>` (e.g. `naples:3`, `fort-myers:14`) before the venue-slug
 * scheme. The legacy KEY can't tell FT from HPFM (both center `fort-myers`) —
 * but the ROW can: it stores the brand, and only a kiosk of that venue ever
 * wrote it. So the fallback is safe exactly when the row's brand matches the
 * slug's brand; loadKioskDevice enforces that. (When FT and HPFM kiosks shared
 * a number they clobbered one `fort-myers:<n>` row — the brand check serves the
 * last writer its own data and gives the other venue a plain miss, never the
 * wrong venue's config.)
 */
export function legacyKioskDeviceLookup(kioskId: string): { key: string; brand: string } | null {
  const [slug, num] = kioskId.split(":");
  if (!num || !/^\d+$/.test(num)) return null;
  if (slug === "HPN") return { key: `naples:${num}`, brand: "headpinz" };
  if (slug === "HPFM") return { key: `fort-myers:${num}`, brand: "headpinz" };
  if (slug === "FT") return { key: `fort-myers:${num}`, brand: "fasttrax" };
  return null;
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
  // No row under the venue-slug key → try the pre-scheme legacy key, accepting
  // the row ONLY when its stored brand matches the slug's venue (see
  // legacyKioskDeviceLookup). This is what lets a kiosk that was provisioned
  // before the slug scheme (and never re-saved through admin) still boot
  // cloud-authoritative from its launch URL; the first save-config/reader-hint
  // after that migrates the config to the new key.
  if (!rows[0]) {
    const legacy = legacyKioskDeviceLookup(kioskId);
    if (legacy) {
      rows = (await query(legacy.key)).filter((r) => String(r.brand) === legacy.brand);
    }
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
