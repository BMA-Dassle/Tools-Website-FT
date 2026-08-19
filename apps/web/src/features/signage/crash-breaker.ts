/**
 * HOW MANY TIMES MAY A WALL PANEL REBOOT ITSELF BEFORE IT STOPS TRYING?
 *
 * The TV error boundary reloads a crashed board, because a transient throw
 * should cost a blink and not an evening (see app/tv/error.tsx). But a
 * DETERMINISTIC crash — a bad build, a feed shape no scene can render — turns
 * that same kindness into nineteen screens reload-looping against our own
 * origin, forever, each one taking a full Next bundle with it.
 *
 * So the boundary counts. Three crashes inside ten minutes and the panel stops
 * recovering and simply sits on the branded ground: still not a white error
 * page in front of guests, still fixed by the next deploy or a power cycle, but
 * no longer hammering.
 *
 * THE COUNT HAS TO OUTLIVE THE PAGE, which is the whole difficulty — every
 * recovery attempt destroys the JS context that would have remembered. Hence
 * localStorage, and hence a module that takes its storage as an argument so the
 * policy is testable without a DOM.
 */

export const CRASH_BREAKER_WINDOW_MS = 10 * 60_000;
export const CRASH_BREAKER_MAX = 3;
export const CRASH_BREAKER_KEY = "tv_crash_times";

/** The slice of localStorage this needs, so a test can hand it a fake. */
export interface CrashStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Record a crash and say whether the panel should still try to recover.
 *
 * FAILS TOWARDS RECOVERING. A missing, unreadable or corrupt store means we
 * cannot know the history — and one reload attempt is far better than parking a
 * guest-facing wall on an error page because private mode ate the counter.
 */
export function noteCrashAndShouldRecover(now: number, store: CrashStore | null): boolean {
  if (!store) return true;
  try {
    const raw = store.getItem(CRASH_BREAKER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const times = Array.isArray(parsed)
      ? parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      : [];
    // Only crashes inside the window count. A screen that threw twice last
    // Tuesday has earned its attempt today.
    const recent = times.filter((t) => now - t < CRASH_BREAKER_WINDOW_MS && t <= now);
    recent.push(now);
    // Keep a little more than the limit so the window logic has something to
    // work with, but never let a looping screen grow the entry without bound.
    store.setItem(CRASH_BREAKER_KEY, JSON.stringify(recent.slice(-CRASH_BREAKER_MAX * 2)));
    return recent.length <= CRASH_BREAKER_MAX;
  } catch {
    return true;
  }
}

/** localStorage, or null where there isn't one. */
export function browserCrashStore(): CrashStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // private mode can throw on ACCESS, not just on read
  }
}
