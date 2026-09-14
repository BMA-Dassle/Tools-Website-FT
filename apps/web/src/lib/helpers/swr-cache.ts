/**
 * STALE-WHILE-REVALIDATE, ONCE. PURE — a clock and a scheduler come in, so the
 * whole state machine is testable with numbers.
 *
 * WHY THIS EXISTS. The Track Ops board has two inputs that are not Redis: the
 * portal's roster (a cross-service GET with a 5s timeout) and the night's
 * briefing counts (a Neon GROUP BY). Both were cached to their own cost, and
 * both had the same hole: the poll that lands the instant a cache expires PAYS
 * the read — every 30s somebody waits on the portal, and if the portal is down
 * that somebody waits the full five seconds. That was tolerable on a 15s wall
 * feed and a 5s desk poll. It is not tolerable on the 2-second pulse, whose
 * whole reason to exist is that nothing slow ever sits in front of it.
 *
 * So: a value that has gone stale is SERVED, and refreshed behind the response.
 * The caller is never slower than a cache hit except on the very first read of
 * an isolate, when there is nothing to serve.
 *
 * ONE HELPER, NOT TWO INLINE COPIES. Dedupe of the in-flight refresh, remembering
 * a failure so a dead upstream costs one attempt per TTL rather than one per poll,
 * and the window in which a last-good value may still stand — each of those is a
 * bug if either copy gets it slightly differently, and the check-in board and the
 * walls would then disagree about who is on the floor.
 *
 *   read(key):
 *     fresh value for this key            → value
 *     stale value, still within maxStaleMs → value NOW, refresh in the background
 *     nothing usable (cold, new key, or    → await load(); a throw is the caller's
 *       stale past maxStaleMs)               to handle
 */

export interface SwrCacheOptions<T> {
  /** How long a loaded value is fresh. */
  ttlMs: number;
  /**
   * How long a stale value may still be SERVED while refreshes fail (or have
   * not happened yet). Past this, the next read awaits a load like a cold one.
   * Null = forever.
   */
  maxStaleMs?: number | null;
  /**
   * After a FAILED load, how long before another is attempted. Defaults to
   * `ttlMs`. This is the "cache the failure too" rule: without it a dead
   * upstream is retried on every poll.
   */
  retryAfterMs?: number;
  /** The slow read. May throw. */
  load: (key: string) => Promise<T>;
  /**
   * Run work after the current response — `afterResponse` in production, a
   * captured promise in tests. Never awaited by `read`.
   */
  schedule: (work: () => Promise<unknown>) => void;
  /** Injected clock, for tests. */
  now?: () => number;
}

export interface SwrCache<T> {
  /**
   * The value for `key` — see the table in the header. `now` overrides the
   * clock for one call (callers that already hold a timestamp pass it so the
   * cache and the rest of their poll agree about the time).
   */
  read(key: string, now?: number): Promise<T>;
  /** What is held right now, without triggering anything. Tests and diagnostics. */
  peek(): { key: string; value: T; at: number } | null;
  /** Drop everything. Tests. */
  reset(): void;
}

export function createSwrCache<T>(opts: SwrCacheOptions<T>): SwrCache<T> {
  const clock = opts.now ?? (() => Date.now());
  const retryAfterMs = opts.retryAfterMs ?? opts.ttlMs;
  const maxStaleMs = opts.maxStaleMs === undefined ? null : opts.maxStaleMs;

  let held: { key: string; value: T; at: number } | null = null;
  /** The last failed load, with its error — re-thrown to a cold caller inside
   *  the retry window so a dead upstream is not re-asked on every poll. */
  let failedAt: { key: string; at: number; error: unknown } | null = null;
  let inFlight: { key: string; promise: Promise<T> } | null = null;
  /** A background refresh handed to the scheduler and not yet settled. */
  let scheduledFor: string | null = null;

  /**
   * ONE LOAD AT A TIME PER KEY. Every concurrent caller — a dozen walls pulsing
   * inside the same isolate — shares the promise, so a slow upstream is asked
   * once, not once per screen.
   */
  const load = (key: string): Promise<T> => {
    if (inFlight && inFlight.key === key) return inFlight.promise;
    const promise = opts
      .load(key)
      .then((value) => {
        held = { key, value, at: clock() };
        failedAt = null;
        return value;
      })
      .catch((err: unknown) => {
        failedAt = { key, at: clock(), error: err };
        throw err;
      })
      .finally(() => {
        if (inFlight && inFlight.promise === promise) inFlight = null;
      });
    inFlight = { key, promise };
    return promise;
  };

  const read = async (key: string, nowArg?: number): Promise<T> => {
    const now = nowArg ?? clock();
    const usable = held && held.key === key ? held : null;

    if (usable && now - usable.at < opts.ttlMs) return usable.value;

    const withinStale =
      usable && (maxStaleMs === null || now - usable.at < opts.ttlMs + maxStaleMs);
    if (usable && withinStale) {
      // Serve stale, refresh behind the response — unless a load for this key
      // failed recently, in which case the failure is what is cached and the
      // stale value simply stands until the retry window opens.
      const recentlyFailed = failedAt && failedAt.key === key && now - failedAt.at < retryAfterMs;
      // ONE refresh per staleness, not one per poll: a dozen reads between the
      // schedule and the moment the scheduler actually runs it must not queue a
      // dozen loads. `scheduledFor` holds the slot until that load settles.
      if (!recentlyFailed && !inFlight && scheduledFor !== key) {
        scheduledFor = key;
        opts.schedule(() =>
          load(key)
            .catch(() => undefined)
            .finally(() => {
              if (scheduledFor === key) scheduledFor = null;
            }),
        );
      }
      return usable.value;
    }

    // Cold (or too stale to serve): the caller waits, as it always did — unless
    // the upstream failed inside the retry window, in which case the failure IS
    // the answer. Re-asking a dead portal on every poll is exactly the stall this
    // helper exists to remove.
    if (failedAt && failedAt.key === key && now - failedAt.at < retryAfterMs && !inFlight) {
      throw failedAt.error;
    }
    return load(key);
  };

  return {
    read,
    peek: () => held,
    reset: () => {
      held = null;
      failedAt = null;
      inFlight = null;
      scheduledFor = null;
    },
  };
}
