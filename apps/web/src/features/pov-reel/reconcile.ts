/**
 * RECONCILE, NEVER REBUILD — the pure half of the nightly run.
 *
 * Given today's ranking and the manifest as it stands, decide what happens to
 * each clip. Kept separate from the cron route and free of any DB or network
 * import so every branch below is testable without a live video, a Neon
 * connection or a Railway service.
 *
 * WHY NOT JUST REBUILD. Re-cutting all ten nightly costs ~94MB of uploads and
 * ten VT3 impressions to reproduce footage we already hold. Most nights the reel
 * barely moves — a rolling 7-day window turns over 1-3 clips a day — so cutting
 * only what changed is the difference between ~28MB and ~94MB of daily churn.
 *
 * THE ONE SUBTLE RULE — a dropped clip is retired on this run and deleted on the
 * NEXT one. Vercel Blob's `del()` is immediate and has no grace period, so
 * deleting on the same run that drops a clip can pull the file out from under a
 * wall that is mid-loop on it. One run of overlap costs ~9.5MB and removes the
 * failure mode entirely. That is why `retire` and `delete` are separate outcomes
 * rather than one "remove".
 */

/** The manifest as reconcile needs to see it — structural, so this module stays
 *  free of the server-only DB import. */
export interface ExistingClip {
  videoCode: string;
  /** Null when the cut was dispatched but never reported. */
  blobUrl: string | null;
  /** Set once the clip has dropped out of the reel on a previous run. */
  retiredAtMs: number | null;
}

/** Today's ranking, narrowed to what reconcile actually reads. */
export interface RankedPick {
  videoCode: string;
  rank: number;
}

export interface ReconcilePlan {
  /** Still in the reel. Update rank, touch nothing else. No re-cut, no /check. */
  keep: Array<{ videoCode: string; rank: number }>;
  /** New entries — dispatch a cut for these. */
  cut: RankedPick[];
  /** Dropped out this run. Stamp retired; the blob lives one more run. */
  retire: string[];
  /** Dropped out on a PREVIOUS run. Delete the blob and the row now. */
  del: string[];
  /**
   * Dispatched previously and never reported back. Re-dispatched rather than
   * left pending forever — the clipper returns 202 and reports out of band, so
   * a run that died mid-job leaves exactly this shape and nothing else retries.
   */
  redispatch: RankedPick[];
}

/**
 * Work out what this run should do.
 *
 * A pick that is already in the manifest WITH a blob is kept untouched. A pick
 * already in the manifest WITHOUT a blob is re-dispatched: it is a job that was
 * asked for and never came back, and nothing else in the system retries it.
 */
export function reconcileReel(
  picked: readonly RankedPick[],
  existing: readonly ExistingClip[],
): ReconcilePlan {
  const byCode = new Map(existing.map((c) => [c.videoCode, c]));
  const pickedCodes = new Set(picked.map((p) => p.videoCode));

  const plan: ReconcilePlan = { keep: [], cut: [], retire: [], del: [], redispatch: [] };

  for (const p of picked) {
    const row = byCode.get(p.videoCode);
    if (!row) {
      plan.cut.push({ videoCode: p.videoCode, rank: p.rank });
      continue;
    }
    if (row.blobUrl) {
      // Survived into today's reel. This is the whole point of reconciling: the
      // footage is already cut and uploaded, so it costs nothing to keep.
      plan.keep.push({ videoCode: p.videoCode, rank: p.rank });
      continue;
    }
    plan.redispatch.push({ videoCode: p.videoCode, rank: p.rank });
  }

  for (const row of existing) {
    if (pickedCodes.has(row.videoCode)) continue;
    // Already retired on an earlier run and still not back in the reel — its
    // grace period is over.
    if (row.retiredAtMs !== null) {
      plan.del.push(row.videoCode);
      continue;
    }
    plan.retire.push(row.videoCode);
  }

  return plan;
}
