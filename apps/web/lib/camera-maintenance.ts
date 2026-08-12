import { sql, isDbConfigured } from "@/lib/db";

/**
 * CAMERAS ON THE BENCH — the maintenance list.
 *
 * WHY IT EXISTS (owner 2026-08-12): "make a maintenance list for cameras you can
 * easily change in database. 3, 6, and 31 can be put on there."
 *
 * The briefing-room return strip found six POV cameras being handed to guests
 * that had filmed nothing in 8 to 89 days. A dead camera never registers, so the
 * strip has no way to stop showing it — it would sit red every night, and six
 * permanent reds is exactly how a board teaches staff to ignore it. Marking a
 * camera as known-broken is the honest fix: it is not missing, it is on the
 * bench.
 *
 * DELIBERATELY THE SIMPLEST TABLE THAT WORKS, because the owner asked to be able
 * to change it in the database by hand. One row per camera, no status enum, no
 * join:
 *
 *   put a camera on the list     INSERT (or use scripts/camera-maintenance.mts)
 *   take a camera off the list   set cleared_at, or just DELETE the row
 *
 * Both readings of "off the list" work, so a hand-edit cannot get it wrong.
 *
 * WHAT IT AFFECTS. A camera on this list is dropped from the return strip
 * entirely — it is not counted, not shown, and not chased. It affects nothing
 * else: no match is suppressed, no video is hidden, and a clip that does arrive
 * from a bench camera still routes to its racer exactly as before. This list
 * changes what a wall asks staff to go and find, and nothing more.
 */

/** One row of the list. */
export interface CameraMaintenanceRow {
  camera: string;
  reason: string | null;
  notedAtMs: number;
  /** Null while the camera is still on the bench. */
  clearedAtMs: number | null;
}

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS camera_maintenance (
      camera_number INT PRIMARY KEY,
      reason        TEXT,
      noted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      noted_by      TEXT,
      cleared_at    TIMESTAMPTZ
    )
  `;
  schemaReady = true;
}

/**
 * How long a reader may keep its answer.
 *
 * The strip rebuilds every few seconds, and a Neon round trip per rebuild for a
 * list that changes a few times a month would be waste. Thirty seconds means a
 * hand-edit in the database shows up on the wall within half a minute, which is
 * as fast as anyone needs and slow enough to cost nothing.
 */
const CACHE_MS = 30_000;
let cache: { at: number; cameras: Set<string> } | null = null;

/**
 * The camera numbers currently on the bench, as text — matching the way camera
 * numbers travel everywhere else in this pipeline (`systemNumber`, the scan log's
 * `sys`), so a caller never has to think about which side is a number.
 *
 * NEVER THROWS, and an empty set is the safe failure: a database hiccup means the
 * strip shows a known-broken camera as missing for a poll or two, which is the
 * behaviour that shipped before this list existed. The opposite failure — a read
 * error silently hiding every camera — would be a board that has quietly stopped
 * doing its job.
 */
export async function listCamerasOutOfService(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cameras;
  if (!isDbConfigured()) return new Set();
  try {
    await ensureSchema();
    const q = sql();
    const rows = (await q`
      SELECT camera_number FROM camera_maintenance WHERE cleared_at IS NULL
    `) as Array<{ camera_number: number }>;
    const cameras = new Set(rows.map((r) => String(r.camera_number)));
    cache = { at: Date.now(), cameras };
    return cameras;
  } catch {
    return cache?.cameras ?? new Set();
  }
}

/** The whole list including cleared rows — for the ops script and any report. */
export async function listCameraMaintenance(
  opts: { includeCleared?: boolean } = {},
): Promise<CameraMaintenanceRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await (opts.includeCleared
    ? q`SELECT camera_number, reason, noted_at, cleared_at FROM camera_maintenance ORDER BY camera_number`
    : q`SELECT camera_number, reason, noted_at, cleared_at FROM camera_maintenance WHERE cleared_at IS NULL ORDER BY camera_number`)) as Array<{
    camera_number: number;
    reason: string | null;
    noted_at: string;
    cleared_at: string | null;
  }>;
  return rows.map((r) => ({
    camera: String(r.camera_number),
    reason: r.reason,
    notedAtMs: Date.parse(r.noted_at),
    clearedAtMs: r.cleared_at ? Date.parse(r.cleared_at) : null,
  }));
}

/** Put a camera on the bench. Re-benching one already on the list refreshes its
 *  reason and re-opens it rather than erroring, which is what a second report of
 *  the same fault should do. */
export async function benchCamera(
  cameraNumber: number,
  reason: string | null,
  notedBy?: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO camera_maintenance (camera_number, reason, noted_by, cleared_at)
    VALUES (${cameraNumber}, ${reason}, ${notedBy ?? null}, NULL)
    ON CONFLICT (camera_number) DO UPDATE
      SET reason = EXCLUDED.reason,
          noted_by = EXCLUDED.noted_by,
          noted_at = now(),
          cleared_at = NULL
  `;
  cache = null;
}

/** Back in service. Keeps the row so the history of what was benched survives. */
export async function returnCameraToService(cameraNumber: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`UPDATE camera_maintenance SET cleared_at = now() WHERE camera_number = ${cameraNumber}`;
  cache = null;
}
