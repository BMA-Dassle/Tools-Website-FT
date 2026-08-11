/**
 * Signage asset manifest (Neon) — one row per uploaded file the screens play.
 *
 * WHY A TABLE AND NOT JUST THE BLOB STORE: a blob URL is not discoverable. The
 * TV has to know WHICH file is the current Starter briefing, and it has to notice
 * when that file changes so it can re-download it. Listing the store and guessing
 * from filenames is exactly the kind of implicit contract that breaks the first
 * time somebody uploads `starter-v2-FINAL.mp4`. So the manifest is authoritative:
 * one row per slot, the row names the URL, and a new upload REPLACES the row.
 *
 * That also makes cache invalidation trivial on the player. Uploads carry a
 * random suffix, so a replaced video is a different URL, and "is this the file I
 * already have?" is string equality — no hashing, no ETag round-trip, no chance
 * of a stale film playing to a room full of people.
 *
 * Raw SQL via @ft/db (no ORM — house rule). Self-creating schema, matching
 * signage-screens-db.
 */
import { sql, isDbConfigured } from "@ft/db";
import type { BriefingAsset, BriefingAssetKey } from "../briefing/types";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS signage_assets (
      asset_key   TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      size_bytes  BIGINT,
      duration_ms INTEGER,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  schemaReady = true;
}

function toAsset(r: Record<string, unknown>): BriefingAsset {
  return {
    key: String(r.asset_key) as BriefingAssetKey,
    url: String(r.url),
    // size_bytes is BIGINT, which the driver hands back as a string. Number() is
    // safe HERE and only here: it is a file size, not a BMI id, and a video
    // larger than 9 petabytes is not a case worth defending against.
    size: r.size_bytes == null ? null : Number(r.size_bytes),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    uploadedAt: r.updated_at == null ? null : String(r.updated_at),
  };
}

/**
 * Record an upload, replacing whatever occupied this slot.
 *
 * Returns the URL that was displaced, so the caller can delete the orphaned blob
 * — the store is not free and a year of replaced briefing videos is real money.
 * Returns null when the slot was empty or the URL is unchanged.
 */
export async function saveSignageAsset(args: {
  key: BriefingAssetKey;
  url: string;
  size: number | null;
  durationMs: number | null;
}): Promise<{ replacedUrl: string | null }> {
  if (!isDbConfigured()) return { replacedUrl: null };
  await ensureSchema();
  const q = sql();
  const prior = (await q`
    SELECT url FROM signage_assets WHERE asset_key = ${args.key} LIMIT 1
  `) as Array<Record<string, unknown>>;
  const previousUrl = prior[0]?.url ? String(prior[0].url) : null;

  await q`
    INSERT INTO signage_assets (asset_key, url, size_bytes, duration_ms, updated_at)
    VALUES (${args.key}, ${args.url}, ${args.size}, ${args.durationMs}, now())
    ON CONFLICT (asset_key) DO UPDATE SET
      url = EXCLUDED.url,
      size_bytes = EXCLUDED.size_bytes,
      duration_ms = EXCLUDED.duration_ms,
      updated_at = now()
  `;

  return { replacedUrl: previousUrl && previousUrl !== args.url ? previousUrl : null };
}

export type SignageAssetMap = Partial<Record<BriefingAssetKey, BriefingAsset>>;

/**
 * Every asset, and NEVER throws — a screen with an unreachable manifest shows
 * its idle board, which is a designed state.
 *
 * Exists as its own export because every caller wants exactly this: wrapping
 * `loadSignageAssets()` in `.catch(() => ({}))` at each call site widened the
 * type to `{}` and lost the keys, so the swallow lives here where it can keep
 * them.
 */
export async function loadSignageAssetsSafe(): Promise<SignageAssetMap> {
  try {
    return await loadSignageAssets();
  } catch {
    return {};
  }
}

/** Every asset, keyed for lookup. Missing rows are simply absent. */
export async function loadSignageAssets(): Promise<SignageAssetMap> {
  if (!isDbConfigured()) return {};
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT asset_key, url, size_bytes, duration_ms, updated_at FROM signage_assets
  `) as Array<Record<string, unknown>>;
  const out: Partial<Record<BriefingAssetKey, BriefingAsset>> = {};
  for (const r of rows) {
    const asset = toAsset(r);
    out[asset.key] = asset;
  }
  return out;
}

/** Drop a slot (admin "remove"). The blob itself is deleted by the caller. */
export async function deleteSignageAsset(key: BriefingAssetKey): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    DELETE FROM signage_assets WHERE asset_key = ${key} RETURNING url
  `) as Array<Record<string, unknown>>;
  return rows[0]?.url ? String(rows[0].url) : null;
}
