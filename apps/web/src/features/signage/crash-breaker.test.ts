import { describe, it, expect } from "vitest";
import {
  CRASH_BREAKER_KEY,
  CRASH_BREAKER_MAX,
  CRASH_BREAKER_WINDOW_MS,
  noteCrashAndShouldRecover,
  type CrashStore,
} from "./crash-breaker";

/** A localStorage stand-in, plus the hostile variants a player actually has. */
function fakeStore(initial?: string): CrashStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_k, v) {
      this.value = v;
    },
  };
}

const T0 = 1_700_000_000_000;

describe("noteCrashAndShouldRecover", () => {
  it("lets a screen recover from the ordinary one-off crash", () => {
    const store = fakeStore();
    expect(noteCrashAndShouldRecover(T0, store)).toBe(true);
  });

  it("STOPS RECOVERING after three crashes in ten minutes", () => {
    // The runaway this exists for: a deterministic crash would otherwise put
    // every screen in the estate into a reload loop against our own origin.
    const store = fakeStore();
    expect(noteCrashAndShouldRecover(T0, store)).toBe(true);
    expect(noteCrashAndShouldRecover(T0 + 20_000, store)).toBe(true);
    expect(noteCrashAndShouldRecover(T0 + 40_000, store)).toBe(true);
    expect(noteCrashAndShouldRecover(T0 + 60_000, store)).toBe(false);
    expect(noteCrashAndShouldRecover(T0 + 80_000, store)).toBe(false);
  });

  it("forgives once the window has passed — a screen that threw an hour ago gets its attempt", () => {
    // A tripped breaker must not be a life sentence: the next deploy, or a quiet
    // hour, has to give the panel its recovery back without a power cycle.
    const store = fakeStore();
    const last = T0 + 5_000;
    for (let t = T0; t <= last; t += 1_000) noteCrashAndShouldRecover(t, store);
    expect(noteCrashAndShouldRecover(last, store)).toBe(false);

    // The window SLIDES, so it clears only once the most recent crash is outside
    // it — not once the first one is. An hour later, every one of them is.
    expect(noteCrashAndShouldRecover(last + CRASH_BREAKER_WINDOW_MS + 1, store)).toBe(true);
  });

  it("the window slides: a crash still inside it keeps the breaker tripped", () => {
    // The other half of the rule above, and the one that makes it a breaker
    // rather than a fixed ten-minute bucket a looping screen could wait out.
    const store = fakeStore();
    for (let i = 0; i <= CRASH_BREAKER_MAX; i++) noteCrashAndShouldRecover(T0 + i * 1_000, store);
    // Well past the FIRST crash's window, but the later ones are still inside it.
    expect(noteCrashAndShouldRecover(T0 + CRASH_BREAKER_WINDOW_MS + 500, store)).toBe(false);
  });

  it("never grows the stored entry without bound, however long it loops", () => {
    // A screen crashing every few seconds for a week must not write an
    // ever-lengthening array into a quota-limited store.
    const store = fakeStore();
    for (let i = 0; i < 500; i++) noteCrashAndShouldRecover(T0 + i * 1_000, store);
    const stored = JSON.parse(store.value!) as number[];
    expect(stored.length).toBeLessThanOrEqual(CRASH_BREAKER_MAX * 2);
  });

  it("FAILS TOWARDS RECOVERING when there is no store at all", () => {
    // Private mode, or a locked-down profile. One reload attempt beats parking a
    // guest-facing wall on an error page because the counter was unavailable.
    expect(noteCrashAndShouldRecover(T0, null)).toBe(true);
  });

  it("fails towards recovering on a corrupt or hostile entry", () => {
    expect(noteCrashAndShouldRecover(T0, fakeStore("not json"))).toBe(true);
    // Wrong shapes must not throw, and must not be counted as crashes either.
    expect(noteCrashAndShouldRecover(T0, fakeStore('{"nope":1}'))).toBe(true);
    expect(noteCrashAndShouldRecover(T0, fakeStore('["a","b","c","d"]'))).toBe(true);
    expect(noteCrashAndShouldRecover(T0, fakeStore("[null,null,null,null]"))).toBe(true);
  });

  it("ignores timestamps from the future, which is how a clock change breaks a counter", () => {
    // Player PCs are documented to carry the wrong time. A stamp from ahead of
    // now must not count towards the limit, or one clock correction could latch
    // a screen out of recovering for the whole window.
    const ahead = JSON.stringify([T0 + 60_000, T0 + 120_000, T0 + 180_000]);
    expect(noteCrashAndShouldRecover(T0, fakeStore(ahead))).toBe(true);
  });

  it("recovers when a store throws on write", () => {
    const store: CrashStore = {
      getItem: () => "[]",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(noteCrashAndShouldRecover(T0, store)).toBe(true);
  });

  it("writes under the documented key, so the entry is findable at a wall", () => {
    let key = "";
    const store: CrashStore = {
      getItem: () => null,
      setItem: (k) => {
        key = k;
      },
    };
    noteCrashAndShouldRecover(T0, store);
    expect(key).toBe(CRASH_BREAKER_KEY);
  });
});
