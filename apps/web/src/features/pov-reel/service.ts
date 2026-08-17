import "server-only";

/**
 * THE NIGHTLY REEL BUILD — rank the week, reconcile, dispatch only what changed.
 *
 * Assembles candidates from three sources that each hold one third of the
 * answer, ranks them with `selectReel`, diffs that against the manifest with
 * `reconcileReel`, and POSTs only the NEW cuts to the Railway clipper. The
 * clipper answers 202 and reports each finished clip back on
 * /api/webhooks/pov-reel-clip.
 *
 * WHY THREE SOURCES. `race_best_laps` knows a lap and the instant it was set but
 * nothing about video; `video-match` knows the footage but nothing about laps;
 * `race_timings` is the only place a pause is recorded, and a stopped race is
 * disqualified. Nothing joins them upstream, so the join is here.
 *
 * NEVER REBUILDS — see reconcile.ts for the two-run retirement that keeps a
 * dropped clip's blob alive one extra run so a wall mid-loop is not cut off.
 */
import { del } from "@vercel/blob";
import { businessDayYmdET } from "@/lib/race-business-day";
import { getBlockState } from "@/lib/video-block";
import { listMatchesInRange, type VideoMatch } from "@/lib/video-match";
import { listFastestLapsSince } from "~/features/racing/data/race-best-laps-db";
import { listRaceTimingsSince } from "~/features/racing/data/race-timings-db";
import { racerMatchesVideo } from "./match-video";
import { reconcileReel } from "./reconcile";
import { selectReel, type ReelCandidate, type ReelSelection } from "./select";
import {
  listAllClips,
  recordDispatch,
  markKept,
  markRetired,
  deleteClip,
} from "./data/pov-reel-clips-db";

const VENUE = "FT";
/** Rolling window, recomputed daily — owner decision 2026-08-17. */
const WINDOW_DAYS = 7;
/** Owner decision: "we don't want to give their secrets away". */
const CLIP_SECONDS = 12;
const PER_TIER = 5;

export interface ReelBuildReport {
  ok: boolean;
  dryRun: boolean;
  window: { from: string; to: string };
  candidates: number;
  eligible: number;
  plan: {
    keep: string[];
    cut: string[];
    redispatch: string[];
    retire: string[];
    delete: string[];
  };
  rejected: Record<string, number>;
  dispatched?: number;
  error?: string;
  clipperStatus?: number;
  clipperBody?: string;
  skipped?: string;
}

/** Business day N days before today, inclusive of today. */
function windowStart(days: number, today = businessDayYmdET()): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

/** Rejection counts by reason — the fastest read on why a reel came up short. */
function summariseRejections(sel: ReelSelection): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of sel.rejected) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}

export async function buildReel(opts: { dryRun: boolean }): Promise<ReelBuildReport> {
  const { dryRun } = opts;
  const to = businessDayYmdET();
  const from = windowStart(WINDOW_DAYS, to);
  const empty: ReelBuildReport = {
    ok: true,
    dryRun,
    window: { from, to },
    candidates: 0,
    eligible: 0,
    plan: { keep: [], cut: [], redispatch: [], retire: [], delete: [] },
    rejected: {},
  };

  const [laps, timings] = await Promise.all([
    listFastestLapsSince(VENUE, from, to, 1000),
    listRaceTimingsSince(VENUE, from, to),
  ]);
  if (laps.length === 0) return { ...empty, skipped: "no laps in window" };

  // Videos are keyed by wall-clock arrival, not business day. Widen by 36h at
  // each end: a race just before the 2am rollover lands its video after it.
  const startMs = Date.parse(`${from}T00:00:00Z`) - 36 * 3600_000;
  const endMs = Date.parse(`${to}T23:59:59Z`) + 36 * 3600_000;
  const matches = await listMatchesInRange({ startMs, endMs, limit: 5000 });

  const timingBySession = new Map(timings.map((t) => [String(t.sessionId), t]));
  const matchesBySession = new Map<string, VideoMatch[]>();
  for (const m of matches) {
    const key = String(m.sessionId);
    const list = matchesBySession.get(key);
    if (list) list.push(m);
    else matchesBySession.set(key, [m]);
  }

  const candidates: ReelCandidate[] = [];
  for (const lap of laps) {
    const t = timingBySession.get(String(lap.sessionId));
    const hits = (matchesBySession.get(String(lap.sessionId)) ?? []).filter((m) =>
      racerMatchesVideo(lap.participantName, m),
    );
    // AMBIGUOUS ABBREVIATION IS NOT A MATCH. "Genn A" fits both "Genn Alvarez"
    // and "Genn Anderson", and within one heat that is entirely possible. Two
    // hits means we cannot tell whose footage this is, and putting the wrong
    // person on a public wall is the one failure worth failing closed for.
    const video = hits.length === 1 ? hits[0] : undefined;
    if (hits.length > 1) {
      console.warn(
        `[pov-reel-build] ambiguous name "${lap.participantName}" in session ` +
          `${lap.sessionId} matched ${hits.length} videos — excluded`,
      );
    }
    candidates.push({
      sessionId: String(lap.sessionId),
      racerName: lap.participantName,
      kart: lap.kart,
      bestLapMs: lap.bestLapMs,
      bestLapAtMs: lap.bestLapAtMs,
      // race_timings holds the authoritative heat name; the lap row's
      // session_name is the fallback for a race predating the timings row.
      heatName: t?.heatName ?? lap.sessionName,
      videoCode: video?.videoCode ?? null,
      videoDurationS: video?.duration ?? null,
      raceDurationS: t?.durationMs != null ? t.durationMs / 1000 : null,
      pauseCount: t?.pauseCount ?? 0,
      blocked: false,
    });
  }

  // Block state is a Redis read per candidate, so it runs only for the ones that
  // could actually reach the wall — those that survived every other rule.
  const provisional = selectReel(candidates, { perTier: PER_TIER, backfill: true });
  await Promise.all(
    provisional.picked.map(async (p) => {
      const video = (matchesBySession.get(p.sessionId) ?? []).find(
        (m) => m.videoCode === p.videoCode,
      );
      if (!video) return;
      const flag = () => {
        const c = candidates.find(
          (x) => x.sessionId === p.sessionId && x.racerName === p.racerName,
        );
        if (c) c.blocked = true;
      };
      try {
        const state = await getBlockState({
          sessionId: video.sessionId,
          personId: video.personId,
          videoCode: p.videoCode ?? undefined,
        });
        if (state.blocked) flag();
      } catch (err) {
        // Fail CLOSED: an unreadable block state must not promote footage onto a
        // public screen. Losing one clip is cheap; showing a blocked one is not.
        console.error(`[pov-reel-build] block read failed for ${p.videoCode}, excluding:`, err);
        flag();
      }
    }),
  );

  const selection = selectReel(candidates, { perTier: PER_TIER, backfill: true });
  const picked = selection.picked;

  const existing = await listAllClips();
  const plan = reconcileReel(
    picked.map((p) => ({ videoCode: p.videoCode as string, rank: p.rank })),
    existing.map((c) => ({
      videoCode: c.videoCode,
      blobUrl: c.blobUrl,
      retiredAtMs: c.retiredAtMs,
    })),
  );

  const report: ReelBuildReport = {
    ok: true,
    dryRun,
    window: { from, to },
    candidates: candidates.length,
    eligible: picked.length,
    plan: {
      keep: plan.keep.map((k) => k.videoCode),
      cut: plan.cut.map((c) => c.videoCode),
      redispatch: plan.redispatch.map((c) => c.videoCode),
      retire: plan.retire,
      delete: plan.del,
    },
    rejected: summariseRejections(selection),
  };
  if (dryRun) return report;

  for (const { videoCode, rank } of plan.keep) await markKept(videoCode, rank);
  for (const videoCode of plan.retire) await markRetired(videoCode);

  // Deletions run BEFORE dispatch so a run that dies mid-cut has still reclaimed
  // the blobs it meant to. Blob first, row second: a row without a blob is a
  // re-dispatch (recoverable); a blob without a row is a leak nothing cleans up.
  for (const videoCode of plan.del) {
    const row = existing.find((c) => c.videoCode === videoCode);
    if (row?.blobUrl) {
      try {
        await del(row.blobUrl);
      } catch (err) {
        console.error(`[pov-reel-build] blob delete failed for ${videoCode}:`, err);
        continue; // keep the row so the next run retries rather than leaking
      }
    }
    await deleteClip(videoCode);
  }

  const toDispatch = [...plan.cut, ...plan.redispatch];
  if (toDispatch.length === 0) {
    console.log(`[pov-reel-build] nothing new to cut (kept ${plan.keep.length})`);
    return { ...report, dispatched: 0 };
  }

  const clipperUrl = process.env.POV_CLIPPER_URL || "";
  const secret = process.env.KART_BRIDGE_SECRET || process.env.VT3_BRIDGE_SECRET || "";
  if (!clipperUrl || !secret) {
    console.error("[pov-reel-build] POV_CLIPPER_URL / KART_BRIDGE_SECRET not set");
    return { ...report, dispatched: 0, error: "clipper not configured" };
  }

  // Row first, then dispatch. The clipper reports asynchronously, so a result
  // arriving before its row exists would be dropped as "not dispatched".
  const byCode = new Map(picked.map((p) => [p.videoCode as string, p]));
  const jobs: Array<Record<string, unknown>> = [];
  for (const [i, { videoCode, rank }] of toDispatch.entries()) {
    const p = byCode.get(videoCode);
    if (!p) continue;
    await recordDispatch({
      videoCode,
      sessionId: p.sessionId,
      racerName: p.racerName,
      tier: p.tier,
      heatName: p.heatName ?? null,
      kart: p.kart,
      bestLapMs: p.bestLapMs,
      bestLapAtMs: p.bestLapAtMs,
      rank,
    });
    jobs.push({
      videoCode,
      racerName: p.racerName,
      bestLapAtMs: p.bestLapAtMs,
      bestLapMs: p.bestLapMs,
      // Rotate the sector or every clip is the same corner.
      sector: (i % 3) as 0 | 1 | 2,
      clipSeconds: CLIP_SECONDS,
      raceDurationS: p.raceDurationS ?? null,
    });
  }

  try {
    const res = await fetch(`${clipperUrl.replace(/\/$/, "")}/build`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kart-bridge-secret": secret },
      body: JSON.stringify({ jobs }),
      // The clipper answers 202 immediately; slower than this is the service
      // being down, not the work being long.
      signal: AbortSignal.timeout(15_000),
    });
    const clipperBody = await res.text();
    if (!res.ok) {
      console.error(`[pov-reel-build] clipper ${res.status}: ${clipperBody}`);
      return { ...report, dispatched: 0, clipperStatus: res.status, clipperBody };
    }
    console.log(`[pov-reel-build] dispatched ${jobs.length} jobs: ${clipperBody}`);
    return { ...report, dispatched: jobs.length, clipperBody };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[pov-reel-build] clipper unreachable:", msg);
    // The rows stay. They have no blob, so the next run re-dispatches them —
    // exactly the `redispatch` branch in reconcile.
    return { ...report, dispatched: 0, error: msg };
  }
}
