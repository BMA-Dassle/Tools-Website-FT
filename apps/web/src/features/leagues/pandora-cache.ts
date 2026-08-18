/**
 * Redis read-through for the Pandora league reads behind /api/leagues.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/api/leagues` was the last guest-facing Pandora reader with NO cache tier at
 * all: every standings view and every cron pass went straight upstream, and when
 * the vendor degrades the route simply 500s. Measured 2026-08-18 20:00Z, during
 * Pandora's person/sessions degradation: **123 × 500 in one hour** on this one
 * route — the public /leagues page showing an error, and
 * `/api/cron/level-up-watch` silently `continue`-ing past every score group
 * (`if (!sessRes.ok) continue`), so nobody was levelled up for the duration.
 *
 * Two separate jobs, both done by the same envelope:
 *
 *   1. A FRESH WINDOW — inside it we answer from Redis and never call Pandora.
 *      Standings move once a league night, so the public page rides an hour
 *      (owner 2026-08-18: "leagues needs a cache for sure, could be hour for
 *      now"). The cron's reads keep a short window instead — see below.
 *
 *   2. A STALE FALLBACK — the copy is RETAINED for hours past the fresh window
 *      and served only when the live call fails. A vendor wobble becomes
 *      last-known-good standings instead of an error page.
 *
 * ── Why the fresh window is per-caller, not one hour for everything ─────────
 * `level-up-watch` (every 2 min) only looks at sessions that finished in the
 * last TEN minutes. Serve it an hour-old session list and the finish is already
 * outside its window by the time it appears — the cache would silently switch
 * level-up detection off. So the route gives the volatile reads (`sessions`,
 * `scores`) a 60s window — long enough to collapse a burst of page views, short
 * enough that the cron's 2-minute pass always sees a real list — and keeps the
 * hour for the standings reads the public page makes.
 *
 * The cache key IS the upstream path, so location, date range, score group and
 * `excludePractice` are all part of it by construction; no key can be derived
 * that doesn't match the request that filled it.
 */
import redis from "@/lib/redis";

/** How long a copy is kept for outage fallback, well past any fresh window. */
const STALE_RETENTION_SECONDS = 6 * 60 * 60;

/** Fresh windows, by how fast the underlying data actually moves. */
export const FRESH_WINDOW_MS = {
  /** Standings / summary — recomputed on league night, read all week. */
  standings: 60 * 60 * 1000,
  /** Sessions / scores — a live league night writes these, and the level-up
   *  cron reads them on a 10-minute relevance window. */
  live: 60 * 1000,
} as const;

/** Where the answer came from. `stale` carries the reason the live call failed. */
export type LeagueCacheSource = "fresh" | "cache" | "stale";

export interface LeagueReadResult {
  /** HTTP status to hand the caller. A served stale copy reports its own 2xx. */
  status: number;
  /** Raw upstream body. Present on every path — the error path needs it too. */
  body: string;
  /** Parsed body, or null when the read failed and nothing was cached. */
  json: unknown | null;
  source: LeagueCacheSource;
  /** Why the live call failed, when a stale copy is being served. */
  staleReason: string | null;
  /** Age of the copy served, or null when the answer came from Pandora. */
  ageMs: number | null;
}

interface Envelope {
  status: number;
  body: string;
  cachedAt: number;
}

function cacheKey(path: string): string {
  return `pandora:leagues:v1:${path}`;
}

/** A body we would rather fail on than cache: Pandora occasionally answers 200
 *  with a non-JSON error page, and a cached one would outlive the outage. */
function parseOrNull(body: string): unknown | null {
  try {
    const parsed = JSON.parse(body);
    return parsed === null ? null : parsed;
  } catch {
    return null;
  }
}

async function readEnvelope(key: string): Promise<Envelope | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope;
    if (typeof env?.body !== "string" || typeof env?.cachedAt !== "number") return null;
    return env;
  } catch (err) {
    console.warn("[leagues-cache] read failed:", err);
    return null;
  }
}

/**
 * Serve `path` from Redis when a copy is younger than `freshForMs`, otherwise
 * call Pandora through `fetcher` and write through. A failed live call falls
 * back to any retained copy, however old, before it reports the failure.
 *
 * `fetcher` is injected so the route keeps ownership of its own HTTP client
 * (and so this is unit-testable without a network).
 */
export async function leagueReadThrough(opts: {
  path: string;
  freshForMs: number;
  /** Bypass the fresh window — still writes through, still falls back to stale. */
  forceFresh?: boolean;
  fetcher: (path: string) => Promise<{ status: number; body: string }>;
}): Promise<LeagueReadResult> {
  const { path, freshForMs, forceFresh = false, fetcher } = opts;
  const key = cacheKey(path);

  // One GET serves both jobs: the fresh-window answer, and the stale copy the
  // failure path would otherwise have to re-read.
  const cached = await readEnvelope(key);

  if (cached && !forceFresh) {
    const ageMs = Date.now() - cached.cachedAt;
    if (ageMs >= 0 && ageMs < freshForMs) {
      return {
        status: cached.status,
        body: cached.body,
        json: parseOrNull(cached.body),
        source: "cache",
        staleReason: null,
        ageMs,
      };
    }
  }

  const stale = (reason: string): LeagueReadResult | null =>
    cached
      ? {
          status: cached.status,
          body: cached.body,
          json: parseOrNull(cached.body),
          source: "stale",
          staleReason: reason,
          ageMs: Date.now() - cached.cachedAt,
        }
      : null;

  let live: { status: number; body: string };
  try {
    live = await fetcher(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "fetch-failed";
    return (
      stale(reason) ?? {
        status: 502,
        body: JSON.stringify({ error: reason }),
        json: null,
        source: "fresh",
        staleReason: null,
        ageMs: null,
      }
    );
  }

  if (live.status >= 400) {
    return (
      stale(`pandora-${live.status}`) ?? {
        status: live.status,
        body: live.body,
        json: null,
        source: "fresh",
        staleReason: null,
        ageMs: null,
      }
    );
  }

  // 200-but-unparseable is an upstream failure in everything but the status
  // code. Never cache it, and prefer a real (older) answer over the junk.
  const json = parseOrNull(live.body);
  if (json === null) {
    return (
      stale("unparseable") ?? {
        status: 502,
        body: live.body,
        json: null,
        source: "fresh",
        staleReason: null,
        ageMs: null,
      }
    );
  }

  const envelope: Envelope = { status: live.status, body: live.body, cachedAt: Date.now() };
  // Fire-and-forget: a Redis hiccup must never fail a good live answer.
  redis
    .set(key, JSON.stringify(envelope), "EX", STALE_RETENTION_SECONDS)
    .catch((err) => console.warn("[leagues-cache] write failed:", err));

  return {
    status: live.status,
    body: live.body,
    json,
    source: "fresh",
    staleReason: null,
    ageMs: null,
  };
}

/** Response headers that say which copy the caller got — the field evidence for
 *  "is the leagues page live or riding the cache right now". */
export function leagueCacheHeaders(result: LeagueReadResult): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Cache":
      result.source === "stale" ? `STALE-${result.staleReason}` : result.source.toUpperCase(),
    ...(result.ageMs === null ? {} : { "X-Cache-Age": String(Math.round(result.ageMs / 1000)) }),
  };
}
