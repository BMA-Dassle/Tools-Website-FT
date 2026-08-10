import redis from "@/lib/redis";
import type { HeatActuals } from "@/lib/video-plausibility";

/**
 * Per-session actual-run-window cache — feeds the video-match
 * plausibility gate (lib/video-plausibility.ts).
 *
 * WHY: the gate needs "when did this assignment's heat actually run"
 * at match time without ever blocking on Pandora. The sessions proxy
 * (/api/pandora/sessions) already fetches every session's actualStart
 * / actualEnd on each successful upstream call, and the pre-race-
 * tickets + checkin-alerts crons keep that proxy warm every 1–2 min
 * during operating hours — so this module just write-throughs the
 * fields the gate needs under a per-session key on the same trigger.
 * Zero additional Pandora calls.
 *
 * Keys: session-actuals:{sessionId} → {"aStart": iso|null, "aEnd": iso|null}
 * TTL 48h — covers the match window (videos dock minutes after the
 * heat; the assignment staleness gate caps eligibility at 8h anyway).
 *
 * Failure posture: every read error returns null and every write
 * error is swallowed — a Redis hiccup must degrade the gate to its
 * scan-anchor rung, never break matching. IDs are treated as opaque
 * strings throughout (BMI/Pandora ids can exceed MAX_SAFE_INTEGER —
 * never Number() them).
 */

const TTL_SECONDS = 48 * 60 * 60;

function key(sessionId: string | number): string {
  return `session-actuals:${String(sessionId)}`;
}

interface StoredActuals {
  aStart: string | null;
  aEnd: string | null;
}

/** Minimal shape of a Pandora session row — matches the sessions
 *  proxy's PandoraSession (actual fields added by Pandora 2026-07-08). */
export interface SessionActualsInput {
  sessionId: string | number;
  actualStart?: string | null;
  actualEnd?: string | null;
}

/**
 * Write-through — called fire-and-forget from the sessions proxy on
 * every successful Pandora fetch. Skips rows with no actuals yet
 * (upcoming heats) EXCEPT to refresh ones we already hold; a plain
 * SET of nulls would erase a previously-stored aStart if Pandora had
 * a bad day, so null-only rows are simply not written.
 */
export async function recordSessionActuals(sessions: SessionActualsInput[]): Promise<void> {
  try {
    const withActuals = sessions.filter(
      (s) => s.sessionId != null && (s.actualStart || s.actualEnd),
    );
    if (withActuals.length === 0) return;
    const pipeline = redis.pipeline();
    for (const s of withActuals) {
      const payload: StoredActuals = {
        aStart: s.actualStart ?? null,
        aEnd: s.actualEnd ?? null,
      };
      pipeline.set(key(s.sessionId), JSON.stringify(payload), "EX", TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (err) {
    console.warn("[session-actuals] write-through failed (non-fatal):", err);
  }
}

/**
 * The gate's read side. Null when unknown (never written, TTL'd out,
 * Redis error) — callers fall to the scan-anchor rung.
 */
export async function getSessionActuals(sessionId: string | number): Promise<HeatActuals | null> {
  try {
    const raw = await redis.get(key(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredActuals;
    const aStartMs = parsed.aStart ? new Date(parsed.aStart).getTime() : NaN;
    const aEndMs = parsed.aEnd ? new Date(parsed.aEnd).getTime() : NaN;
    const out: HeatActuals = {};
    if (Number.isFinite(aStartMs)) out.aStartMs = aStartMs;
    if (Number.isFinite(aEndMs)) out.aEndMs = aEndMs;
    return out.aStartMs == null && out.aEndMs == null ? null : out;
  } catch {
    return null;
  }
}
