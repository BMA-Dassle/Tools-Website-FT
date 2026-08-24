import redis from "@/lib/redis";

/**
 * EVERY SCAN, WHAT IT WAS, AND HOW LONG IT TOOK.
 *
 * Born from a race night (2026-08-20) where the desk reported "the board is
 * very slow" and there was no way to answer the only questions that mattered:
 * how slow, for which kind of badge, and where the time went. Pandora was
 * answering /bmi/races/current in 16-30s, but establishing that took a laptop
 * with production secrets on it. A ring buffer the desk itself can open turns
 * that into a button.
 *
 * A REDIS LIST, CAPPED AND EXPIRING. `lpush` + `ltrim` keeps the newest
 * MAX_ENTRIES and nothing else, so it cannot grow without bound however busy a
 * night gets, and the TTL means a quiet week leaves nothing behind. This is
 * diagnostics, not a ledger — the durable record of a check-in is the BMI write
 * and our own roster set, both of which are unaffected by anything in here.
 *
 * NEVER THROWS, NEVER AWAITED ON THE CRITICAL PATH. A racer is standing at the
 * desk while this happens. Every function swallows its own failures, and the
 * caller fires the write without waiting for it.
 *
 * NO GUEST PII BEYOND A FIRST NAME. This is a staff diagnostic surface and it
 * is read on the check-in board, which sits where guests can see it. First name
 * is what the flash card already shows; surname, phone and email have no
 * diagnostic value and are not recorded.
 */

/** What was physically presented at the desk. */
export type ScanKind =
  | "licence" // wallet racing licence / member app QR
  | "eticket" // FT:personId:sessionId
  | "eticket-move" // FT:personId:sessionId:participantId (move-resilient)
  | "paper" // bare participant id
  | "arena" // HP:locationId:… arena ticket
  | "unparsed"; // nothing we recognise

/** How it ended, in the desk's language rather than HTTP's. */
export type ScanOutcome =
  | "checked-in"
  | "already-in" // re-scan of the same racer into the same heat
  | "not-checking-in" // real racer, heat not called (the yellow card)
  | "not-found" // nobody matched
  | "failed" // upstream write or lookup failed
  | "unreadable"; // the payload never parsed — a 400, not a scan we understood

export interface ScanHistoryEntry {
  atMs: number;
  kind: ScanKind;
  outcome: ScanOutcome;
  /** Total server time for the scan, milliseconds. */
  totalMs: number;
  /** Per-step timings — whichever steps this scan actually ran. */
  ms?: Record<string, number>;
  track?: string | null;
  heatNumber?: number | null;
  sessionId?: string | null;
  /** First name only — see the PII note above. */
  firstName?: string | null;
  /** True for a gear "Look up", which wrote nothing. */
  dryRun?: boolean;
  /** A headsock was flagged as due on this scan. */
  headsock?: boolean;
  /**
   * WHY IT DIDN'T WORK. Only set on `failed` / `unreadable` / `not-found`.
   *
   * Without this a failure reads as the word "failed" and nothing else, which
   * is the least useful thing a diagnostic can say at 8pm with a queue at the
   * desk. Carries the upstream's own message (a Pandora status line, or the
   * parse rejection), truncated — never a stack trace, never guest PII beyond
   * what the first-name field already holds.
   */
  detail?: string | null;
  /** HTTP status, when it was not 200. Absent on a normal scan. */
  status?: number;
}

const KEY = "checkin:scan-history";
/** Roughly a full weekend of scans, and small: ~200 bytes each. */
const MAX_ENTRIES = 500;
const TTL_SEC = 14 * 24 * 60 * 60;

/**
 * Fire-and-forget. Returns a promise only so a caller that genuinely wants to
 * await (a test) can — production callers should `void` it.
 */
export async function recordScan(entry: ScanHistoryEntry): Promise<void> {
  try {
    await redis.lpush(KEY, JSON.stringify(entry));
    await redis.ltrim(KEY, 0, MAX_ENTRIES - 1);
    await redis.expire(KEY, TTL_SEC);
  } catch {
    /* diagnostics must never be able to affect a check-in */
  }
}

/** Newest first. A malformed row is skipped rather than failing the read. */
export async function readScanHistory(limit = 100): Promise<ScanHistoryEntry[]> {
  const n = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit)));
  try {
    const rows = await redis.lrange(KEY, 0, n - 1);
    const out: ScanHistoryEntry[] = [];
    for (const row of rows ?? []) {
      try {
        const parsed = JSON.parse(row) as ScanHistoryEntry;
        if (parsed && typeof parsed.atMs === "number") out.push(parsed);
      } catch {
        /* one bad row must not hide the rest */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Aggregates for the panel header — computed here rather than in the component
 * so the numbers and the rows can never tell different stories. PURE.
 *
 * The median matters more than the mean on this data: one 9-second Pandora
 * timeout in a hundred fast scans drags a mean somewhere no actual scan was.
 */
export interface ScanHistoryStats {
  n: number;
  medianMs: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
  byOutcome: Record<string, number>;
  byKind: Record<string, number>;
}

export function summariseScans(entries: ScanHistoryEntry[]): ScanHistoryStats {
  const real = entries.filter((e) => !e.dryRun);
  /**
   * TIMINGS EXCLUDE `unreadable`, COUNTS DO NOT.
   *
   * A payload that never parsed is rejected in ~80ms without touching an
   * upstream. Letting those into the percentiles would pull the median toward
   * "the desk is fast" precisely when a scanner is emitting garbage and every
   * other scan is timing out — the reading would improve as the night got
   * worse. They still appear in `byOutcome`, which is where they matter.
   */
  const times = real
    .filter((e) => e.outcome !== "unreadable")
    .map((e) => e.totalMs)
    .filter((n) => typeof n === "number" && n >= 0)
    .sort((a, b) => a - b);

  const at = (q: number): number | null => {
    if (times.length === 0) return null;
    const i = Math.min(times.length - 1, Math.max(0, Math.ceil(q * times.length) - 1));
    return times[i];
  };

  const byOutcome: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const e of real) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }

  return {
    n: real.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    slowestMs: times.length ? times[times.length - 1] : null,
    byOutcome,
    byKind,
  };
}
