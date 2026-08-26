import { NextResponse } from "next/server";
import redis from "@/lib/redis";
import { megaModeWithoutFlag } from "~/features/signage/service/mega-mode.server";
import { getOnTime, type OnTimeSnapshot } from "~/features/racing/on-time.server";
import { getNextCheckIns, type NextCheckInByTrack } from "~/features/racing/session-call.server";

/**
 * Cached proxy for the BMA track-status service that drives the
 * "Live Track Status — On Time / +N Min" widget on the home page,
 * racing page, e-tickets, etc.
 *
 *   GET /api/track-status
 *
 * Upstream:
 *   GET https://tools-track-status.vercel.app/api/v1/status
 *
 * Caching strategy: Redis-backed, shared across all Vercel lambda
 * instances. One upstream call every ~30s no matter how many
 * concurrent client requests come in.
 *
 * Hot path:
 *   1. Read `track-status:cache:v1` from Redis
 *   2. If freshness age < 30s → serve immediately, no upstream call
 *
 * Slow path (cache stale or missing):
 *   3. Try to acquire `track-status:lock` (SET NX EX 5)
 *   4. If we got the lock → fetch upstream, write cache, release lock
 *   5. If we didn't (another instance is fetching) → serve whatever's
 *      in cache even if slightly stale, rather than dog-pile upstream
 *
 * Failure path:
 *   6. Upstream timeout / non-2xx → fall back to the last known cache
 *      so the widget keeps showing something instead of blanking out,
 *      up to MAX_SERVE_AGE_MS (past that we genuinely don't know, and
 *      a stale delay figure is worse than none — see below)
 *
 * Hooks/components consuming this:
 *   - hooks/useTrackStatus.ts  (powers <TrackStatus /> on home/racing
 *                                + every e-ticket / group e-ticket)
 *
 * ── `onTime`: OUR OWN NUMBERS, added 2026-08-17 ─────────────────────
 *
 * Every response now also carries an `onTime` block computed from our
 * own two archives (features/racing/on-time.server.ts). It is ADDITIVE:
 * the upstream `tracks[]` array is passed through untouched, so nothing
 * that reads it can break, and `megaTrackEnabled` still comes from the
 * upstream (plus the synthetic ladder) because we cannot derive it.
 *
 * WHY OURS AT ALL. The upstream calls a heat delayed only once it is 30
 * minutes past its slot, which on 2026-08-16 marked 1 heat out of 100 —
 * green by construction, and so carrying no information. Ours measures
 * lateness at the CALL, which is the moment the printed slot actually
 * names, and surfaces late calls as exceptions. See on-time.ts for why
 * that distinction is the whole ballgame.
 *
 * KILL SWITCH: ONTIME_OWN_SOURCE=false drops the block and leaves this
 * route exactly as it was. Default ON — a merged feature is on.
 */

const UPSTREAM = "https://tools-track-status.vercel.app/api/v1/status";
const CACHE_KEY = "track-status:cache:v1";
const LOCK_KEY = "track-status:lock";

// Freshness — when we go back to upstream. Independent of retention.
const FRESH_MS = 30_000;

// Hard ceiling on the upstream call. Without one, a hung upstream pins
// the lock holder for the whole function duration (2026-08-13: upstream
// stopped answering entirely and we measured >20s with no response).
// When it's healthy it answers in well under a second, so any budget in
// the 8-15s band detects the outage identically; 10s keeps the unlucky
// request that holds the lock comfortably inside the client's 20s poll
// cycle.
const UPSTREAM_TIMEOUT_MS = 10_000;

// MUST exceed UPSTREAM_TIMEOUT_MS. At the old 5s the lock expired while
// its holder was still waiting on a hung upstream, so a second instance
// acquired it and hung too — the stampede protection dropped out at
// exactly the moment it was needed, adding a hanging fetch every 5s to
// an upstream already in trouble.
const LOCK_TTL_SEC = 15;

// How stale a reading we're willing to state. There is no free answer
// here: track delay turns over with each heat (~12 min), so an old
// reading is read by a guest as current — but a hidden widget tells
// them nothing at all.
//
// Walked this out twice on 2026-08-13 against the live outage. 10 min
// aged out mid-outage and blanked the widget on the home page, the
// racing page and every e-ticket; 45 min would have run out too. The
// call is to keep showing the last real reading for the whole plausible
// length of an outage rather than drop it (owner, same night).
//
// The cap stays rather than going infinite: a reading from before the
// centre opened is not a delay, it is a fossil. 3h is long enough that
// the widget survives any outage we have actually seen.
const MAX_SERVE_AGE_MS = 3 * 60 * 60_000;

// RETENTION, not freshness. This was 60s, which is what actually caused
// the 503 storm: once upstream had been down for a minute Redis evicted
// the key, so `cached` was null on every path and the fallback promised
// above had nothing to fall back TO. An outage must not be able to
// delete our last known good value.
//
// MUST stay comfortably above MAX_SERVE_AGE_MS. If Redis drops the key
// first then the serve cap is decorative — the route goes back to
// having nothing to fall back to, which is the original bug wearing a
// different number. Double it, so retention is never the binding
// constraint.
const CACHE_TTL_SEC = (MAX_SERVE_AGE_MS / 1000) * 2;

interface CachedEntry {
  fetchedAt: number;
  data: unknown;
}

/**
 * The blocks WE compute, as opposed to the ones the upstream sends. Carried
 * together so every serve path merges both without eight more signatures.
 */
interface OwnBlocks {
  onTime: OnTimeSnapshot | null;
  nextCheckIn: NextCheckInByTrack | null;
}

async function readCache(): Promise<CachedEntry | null> {
  try {
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedEntry;
  } catch {
    return null;
  }
}

async function writeCache(data: unknown): Promise<void> {
  try {
    await redis.set(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), data }),
      "EX",
      CACHE_TTL_SEC,
    );
  } catch {
    /* best-effort */
  }
}

/** Returns our lock token if we won the race, else null. */
async function tryAcquireLock(): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(LOCK_KEY, token, "EX", LOCK_TTL_SEC, "NX");
    return ok === "OK" ? token : null;
  } catch {
    return null;
  }
}

// Compare-and-delete, atomically. A blind DEL is only safe while no
// holder can outlive LOCK_TTL_SEC — and a slow upstream is exactly the
// case where one does. Once our lock has expired and another instance
// has legitimately taken it, deleting it frees THEIR lock and invites a
// third instance to pile onto an upstream we already know is struggling.
const RELEASE_IF_MINE = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

async function releaseLock(token: string): Promise<void> {
  try {
    await redis.eval(RELEASE_IF_MINE, 1, LOCK_KEY, token);
  } catch {
    /* ignore */
  }
}

/**
 * OUR on-time block, or null.
 *
 * NEVER THROWS, and never blocks the upstream answer. This route's first job is
 * still to keep `megaTrackEnabled` and the delay rows flowing; our own metric is
 * a passenger on it. A Neon blip must cost the block, not the response.
 */
async function readOwnOnTime(): Promise<OwnBlocks> {
  if (process.env.ONTIME_OWN_SOURCE === "false") return { onTime: null, nextCheckIn: null };
  let onTime: OnTimeSnapshot | null = null;
  try {
    onTime = await getOnTime();
  } catch (err) {
    console.error("[track-status] own on-time read failed", err);
  }
  // The call window rides on the same request because every surface that wants
  // one already polls this route — see session-call.server.ts. It depends on the
  // snapshot for each track's live offset, so it is read after, not alongside.
  let nextCheckIn: NextCheckInByTrack | null = null;
  try {
    nextCheckIn = await getNextCheckIns(onTime);
  } catch (err) {
    console.error("[track-status] next check-in read failed", err);
  }
  return { onTime, nextCheckIn };
}

/**
 * Merge our blocks into whatever the upstream (or the fallback) produced.
 *
 * Each is independently omitted when absent, so a surface can never tell a
 * missing block from an empty one by accident: no `onTime` means we could not
 * compute it, and no `nextCheckIn` means the same. Both read as "fall back to the
 * printed schedule", which is what every consumer already does.
 */
function withOnTime(data: unknown, own: OwnBlocks): unknown {
  if (typeof data !== "object" || data === null) return data;
  const out = { ...(data as Record<string, unknown>) };
  if (own.onTime) out.onTime = own.onTime;
  if (own.nextCheckIn && Object.keys(own.nextCheckIn).length > 0) {
    out.nextCheckIn = own.nextCheckIn;
  }
  return out;
}

/** Serve a cached reading, tagging how we arrived at it. */
function serveCached(
  entry: CachedEntry,
  cacheState: string,
  own: OwnBlocks,
  extra?: Record<string, string>,
): NextResponse {
  return NextResponse.json(withOnTime(entry.data, own), {
    headers: {
      "X-Cache": cacheState,
      "X-Cache-Age-Ms": String(Date.now() - entry.fetchedAt),
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

/** Stale is fine; ancient is a wrong answer stated confidently. */
function servable(entry: CachedEntry | null): entry is CachedEntry {
  return entry !== null && Date.now() - entry.fetchedAt <= MAX_SERVE_AGE_MS;
}

/**
 * LAST RESORT: the upstream is dark and the cache is past the serve ceiling
 * (or gone). This used to be a 503/502, which the client hook rightly
 * discards — meaning a dead status app also took `megaTrackEnabled` down
 * with it, on the one night that flag matters most.
 *
 * Instead, answer the ONE question we can still answer without the upstream:
 * are we in mega mode? megaModeWithoutFlag runs the resilience ladder —
 * called mega heat → BMI dayplanner → Mega-day calendar (owner 2026-08-16:
 * "can't always guarantee the track status app will be up"). `tracks: []`
 * is honest: we genuinely do not know the delays, and every consumer already
 * renders an empty delay list; `degraded: true` marks the payload for
 * anyone debugging why the widget has no rows.
 */
async function serveSynthetic(cacheState: string, own: OwnBlocks, extra?: Record<string, string>) {
  const megaTrackEnabled = await megaModeWithoutFlag().catch(() => false);
  return NextResponse.json(
    // `onTime` survives a dark upstream on purpose: it is computed from OUR
    // archives, so an outage over there is exactly when it is most useful.
    withOnTime({ megaTrackEnabled, tracks: [], degraded: true }, own),
    {
      headers: { "X-Cache": cacheState, "Cache-Control": "no-store", ...(extra ?? {}) },
    },
  );
}

export async function GET() {
  // Ours and theirs are independent reads, so start ours immediately rather
  // than after the upstream dance — on the HIT path this is the only latency
  // either of them adds, and it is a Redis get.
  const onTimePromise = readOwnOnTime();

  // ── Hot path: serve fresh cache ─────────────────────────────────────
  const cached = await readCache();
  const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && ageMs < FRESH_MS) {
    return serveCached(cached, "HIT", await onTimePromise);
  }

  // ── Slow path: cache stale (or missing). Try to be the one fetcher. ─
  const lockToken = await tryAcquireLock();

  if (!lockToken) {
    // Someone else is fetching — return what we have (even stale)
    // rather than dog-pile upstream.
    if (servable(cached)) return serveCached(cached, "STALE-LOCKED", await onTimePromise);

    // Nothing servable + can't get the lock → give the holder a moment
    // and look again; it may have just written a fresh value.
    await new Promise((r) => setTimeout(r, 250));
    const retried = await readCache();
    if (servable(retried)) return serveCached(retried, "WAITED", await onTimePromise);

    return serveSynthetic("SYNTH-LOCKED", await onTimePromise);
  }

  // We hold the lock — fetch upstream, bounded.
  try {
    const res = await fetch(`${UPSTREAM}?_t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = await res.json();
    // Cache the UPSTREAM payload only. Ours has its own (much shorter) cache and
    // must not be frozen for three hours behind the upstream's serve ceiling.
    await writeCache(data);
    return NextResponse.json(withOnTime(data, await onTimePromise), {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const reason = (err instanceof Error ? err.message : "fetch failed").slice(0, 100);
    // Upstream failed — serve the last known reading if it's recent
    // enough to still mean something, else synthesize.
    if (servable(cached)) {
      return serveCached(cached, "STALE-ERROR", await onTimePromise, {
        "X-Upstream-Error": reason,
      });
    }
    return serveSynthetic("SYNTH-ERROR", await onTimePromise, { "X-Upstream-Error": reason });
  } finally {
    await releaseLock(lockToken);
  }
}
