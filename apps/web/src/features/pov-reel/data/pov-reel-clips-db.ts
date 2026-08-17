import "server-only";

/**
 * THE REEL'S MANIFEST — one row per cut clip (Neon).
 *
 * KEYED ON `video_code`, deliberately, and NOT on (week, rank). A clip's
 * identity is the footage it was cut from; its rank is a property of today's
 * ranking and changes nightly. Keying on rank cannot express the state that
 * matters most — "this clip was in yesterday's top ten and is still in today's"
 * — which is the whole basis of reconciling instead of rebuilding.
 *
 * WHY RECONCILE AND NEVER REBUILD. Re-cutting all ten nightly would burn ~94MB
 * of uploads and ten VT3 impressions to reproduce yesterday's reel. A clip that
 * survives into today's top ten is kept untouched: no re-cut, no `/check` (which
 * counts as a VT3 impression and pollutes `VideoMatch.viewed`), no new blob.
 *
 * THE TWO-RUN RETIREMENT. A clip that drops out is NOT deleted on the run that
 * drops it — it is stamped `retired_at` and deleted on the NEXT run. A wall may
 * be mid-loop on that blob, and Vercel Blob has no grace period: `del()` is
 * immediate and a playing <video> would stall. One run of overlap is the cheapest
 * possible guarantee that nothing vanishes under a screen.
 *
 * ROWS ARE INSERTED BEFORE THE CLIP EXISTS. The cron knows the racer, tier and
 * rank; the clipper knows only the blob it produced. So the cron inserts the row
 * when it dispatches the job and the result webhook fills in `blob_url` when the
 * cut lands. A row with a NULL `blob_url` is therefore a job that was dispatched
 * and never came back — which is the signal a clipper failure would otherwise
 * leave only in Railway's stdout.
 *
 * IDS ARE TEXT — house rule, CLAUDE.md.
 */
import { sql, isDbConfigured } from "@ft/db";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS pov_reel_clips (
      video_code    TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      racer_name    TEXT NOT NULL,
      tier          TEXT NOT NULL,
      heat_name     TEXT,
      kart          TEXT,
      best_lap_ms   INTEGER NOT NULL,
      best_lap_at   TIMESTAMPTZ NOT NULL,
      blob_url      TEXT,
      bytes         INTEGER,
      cut_at_s      DOUBLE PRECISION,
      anchor        TEXT,
      rank          INTEGER,
      dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      built_at      TIMESTAMPTZ,
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      retired_at    TIMESTAMPTZ
    )
  `;
  // The wall's read: everything live, in reel order.
  await q`
    CREATE INDEX IF NOT EXISTS pov_reel_clips_rank_idx
      ON pov_reel_clips (retired_at, rank)
  `;
  schemaReady = true;
}

export interface PovReelClip {
  videoCode: string;
  sessionId: string;
  racerName: string;
  tier: string;
  heatName: string | null;
  kart: string | null;
  bestLapMs: number;
  bestLapAtMs: number;
  /** NULL while the cut is still outstanding — see the header. */
  blobUrl: string | null;
  bytes: number | null;
  cutAtS: number | null;
  /**
   * "burn-in" (exact) or "estimate" (the ~55s-wrong centring fallback). Stored
   * rather than discarded because a WALL of estimates means OCR is broken inside
   * the container, and that is only visible in aggregate.
   */
  anchor: string | null;
  rank: number | null;
  retiredAtMs: number | null;
}

function toRow(r: Record<string, unknown>): PovReelClip {
  return {
    videoCode: String(r.video_code),
    sessionId: String(r.session_id),
    racerName: String(r.racer_name),
    tier: String(r.tier),
    heatName: r.heat_name == null ? null : String(r.heat_name),
    kart: r.kart == null ? null : String(r.kart),
    bestLapMs: Number(r.best_lap_ms),
    bestLapAtMs: Date.parse(String(r.best_lap_at)),
    blobUrl: r.blob_url == null ? null : String(r.blob_url),
    bytes: r.bytes == null ? null : Number(r.bytes),
    cutAtS: r.cut_at_s == null ? null : Number(r.cut_at_s),
    anchor: r.anchor == null ? null : String(r.anchor),
    rank: r.rank == null ? null : Number(r.rank),
    retiredAtMs: r.retired_at == null ? null : Date.parse(String(r.retired_at)),
  };
}

/** Every row, retired ones included — the reconcile needs both halves. */
export async function listAllClips(): Promise<PovReelClip[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT video_code, session_id, racer_name, tier, heat_name, kart,
           best_lap_ms, best_lap_at, blob_url, bytes, cut_at_s, anchor, rank, retired_at
    FROM pov_reel_clips
    ORDER BY rank ASC NULLS LAST
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * What the wall plays: live clips that actually have a blob, in reel order.
 *
 * Retired rows are excluded even though their blob survives one more run — the
 * grace period exists so a screen already playing a clip is not cut off, not so
 * a fresh loop picks it up again.
 */
export async function listPlayableClips(): Promise<PovReelClip[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT video_code, session_id, racer_name, tier, heat_name, kart,
           best_lap_ms, best_lap_at, blob_url, bytes, cut_at_s, anchor, rank, retired_at
    FROM pov_reel_clips
    WHERE retired_at IS NULL AND blob_url IS NOT NULL
    ORDER BY rank ASC NULLS LAST
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

export interface DispatchedClip {
  videoCode: string;
  sessionId: string;
  racerName: string;
  tier: string;
  heatName: string | null;
  kart: string | null;
  bestLapMs: number;
  bestLapAtMs: number;
  rank: number;
}

/**
 * Record that a cut has been asked for. Idempotent on `video_code`, so a cron
 * that runs twice does not create a second row for the same footage.
 *
 * Deliberately does NOT clear `blob_url`: re-dispatching a code we already hold
 * a blob for must not blank the manifest the wall is reading from.
 */
export async function recordDispatch(clip: DispatchedClip): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO pov_reel_clips
      (video_code, session_id, racer_name, tier, heat_name, kart,
       best_lap_ms, best_lap_at, rank)
    VALUES
      (${clip.videoCode}, ${clip.sessionId}, ${clip.racerName}, ${clip.tier},
       ${clip.heatName}, ${clip.kart}, ${Math.round(clip.bestLapMs)},
       ${new Date(clip.bestLapAtMs).toISOString()}, ${clip.rank})
    ON CONFLICT (video_code) DO UPDATE SET
      rank         = EXCLUDED.rank,
      tier         = EXCLUDED.tier,
      last_seen_at = now(),
      retired_at   = NULL
  `;
}

/**
 * The clipper reported a finished cut. Writes the blob details onto the row the
 * cron already created.
 *
 * UPDATE, never upsert: a result for a code we never dispatched is not ours to
 * publish, and silently inserting it would put unranked footage on the wall.
 * Returns whether a row was matched so the caller can log the mismatch.
 */
export async function recordClipResult(res: {
  videoCode: string;
  url: string;
  bytes: number;
  cutAtS: number;
  anchor: string;
}): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    UPDATE pov_reel_clips
    SET blob_url = ${res.url},
        bytes    = ${Math.round(res.bytes)},
        cut_at_s = ${res.cutAtS},
        anchor   = ${res.anchor},
        built_at = now()
    WHERE video_code = ${res.videoCode}
    RETURNING video_code
  `) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/** Still in the reel: bump the rank and clear any pending retirement. */
export async function markKept(videoCode: string, rank: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE pov_reel_clips
    SET rank = ${rank}, last_seen_at = now(), retired_at = NULL
    WHERE video_code = ${videoCode}
  `;
}

/** Dropped out of the reel. The blob survives one more run — see the header. */
export async function markRetired(videoCode: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE pov_reel_clips
    SET retired_at = now(), rank = NULL
    WHERE video_code = ${videoCode} AND retired_at IS NULL
  `;
}

/** The row is gone; the caller deletes the blob. */
export async function deleteClip(videoCode: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`DELETE FROM pov_reel_clips WHERE video_code = ${videoCode}`;
}
