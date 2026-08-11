/**
 * Signage screen registry (Neon) — one row per physical TV.
 *
 * Deliberately its OWN table rather than a `deviceKind` column on
 * `kiosk_devices`: the two device classes share a naming scheme but nothing
 * else (a kiosk row carries card-reader ports, MSR baud, dispenser ids), and
 * the kiosk registry is a revenue-path table that should not gain rows whose
 * shape it never reads. Separate tables also make the key spaces independent —
 * `HPFM:1` as a TV can never collide with `HPFM:1` as a kiosk.
 *
 * Raw SQL via @/lib/db (no ORM — house rule). Self-creating schema, matching
 * the kiosk-devices / bowling-db pattern.
 */
import { sql, isDbConfigured } from "@/lib/db";
import type { ScreenConfig, SignageScreen } from "../types";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS signage_screens (
      screen_id     TEXT PRIMARY KEY,
      venue         TEXT NOT NULL,
      center        TEXT NOT NULL,
      screen_number INTEGER NOT NULL DEFAULT 1,
      name          TEXT NOT NULL DEFAULT '',
      config        JSONB NOT NULL DEFAULT '{}'::jsonb,
      token         TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  schemaReady = true;
}

function toScreen(r: Record<string, unknown>): SignageScreen {
  return {
    screenId: String(r.screen_id),
    venue: String(r.venue),
    center: String(r.center),
    screenNumber: Number(r.screen_number),
    name: String(r.name ?? ""),
    config: (r.config as ScreenConfig) ?? {},
    updatedAt: String(r.updated_at),
  };
}

/** Create or update a screen. Called from the admin page only. */
export async function saveSignageScreen(args: {
  screenId: string;
  venue: string;
  center: string;
  screenNumber: number;
  name: string;
  config: ScreenConfig;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO signage_screens (screen_id, venue, center, screen_number, name, config, updated_at)
    VALUES (${args.screenId}, ${args.venue}, ${args.center}, ${args.screenNumber},
            ${args.name}, ${JSON.stringify(args.config)}::jsonb, now())
    ON CONFLICT (screen_id) DO UPDATE SET
      venue = EXCLUDED.venue,
      center = EXCLUDED.center,
      screen_number = EXCLUDED.screen_number,
      name = EXCLUDED.name,
      config = EXCLUDED.config,
      updated_at = now()
  `;
}

/**
 * Look up one screen by its key (`HPFM:1`). A miss is not an error — an
 * unprovisioned screen boots the ads-only default, so the wall shows house
 * advertising instead of a setup prompt in front of guests.
 */
export async function loadSignageScreen(screenId: string): Promise<SignageScreen | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT screen_id, venue, center, screen_number, name, config, updated_at
    FROM signage_screens WHERE screen_id = ${screenId} LIMIT 1
  `) as Array<Record<string, unknown>>;
  const r = rows[0];
  return r ? toScreen(r) : null;
}

/** Every provisioned screen (admin overview). */
export async function listSignageScreens(): Promise<SignageScreen[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT screen_id, venue, center, screen_number, name, config, updated_at
    FROM signage_screens ORDER BY venue, screen_number
  `) as Array<Record<string, unknown>>;
  return rows.map(toScreen);
}

/** Retire a screen. The TV itself keeps running on its cached config until it
 *  is unplugged — deleting the row stops it being managed, not being lit. */
export async function deleteSignageScreen(screenId: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`DELETE FROM signage_screens WHERE screen_id = ${screenId}`;
}
