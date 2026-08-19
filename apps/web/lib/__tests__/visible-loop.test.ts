import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startVisibleLoop } from "../visible-loop";

/**
 * The three invariants a wall panel's poll loop has to hold for weeks at a
 * time. Two of them were broken in production on 2026-08-17 (the FT results
 * wall froze until it was reloaded by hand); each has a test named for the
 * failure, not for the mechanism.
 */

const DELAY = 15_000;
const TIMEOUT = 20_000;

/** Lets the test settle the microtask queue between timer advances — the loop
 *  awaits inside each cycle, so advancing timers alone is not enough. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Advance fake timers and let every promise the tick released settle. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startVisibleLoop — cadence", () => {
  it("runs at once and then on the cadence", async () => {
    const run = vi.fn();
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    await advance(DELAY);
    expect(run).toHaveBeenCalledTimes(2);

    await advance(DELAY);
    expect(run).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("waits for a slow cycle to settle before scheduling the next", async () => {
    // The no-overlap rule: cycle N+1 starts DELAY after N finished, not DELAY
    // after it started, so a slow upstream can never stack pending promises.
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10_000));
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    await advance(DELAY); // the cycle is still running for the first 10s of this
    expect(run).toHaveBeenCalledTimes(1);

    await advance(10_000); // 10s in flight + 15s gap = 25s
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});

describe("startVisibleLoop — a cycle that never finishes", () => {
  it("ABORTS THE STALLED CYCLE AND KEEPS POLLING (the wall froze because it did not)", async () => {
    // A `fetch` over a stalled connection never settles and never rejects. With
    // no watchdog the await below would hold the loop forever and the screen
    // would sit on its last good feed until somebody reloaded the page.
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>(() => {}); // never resolves, never rejects
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);

    await advance(TIMEOUT);
    expect(signals[0].aborted).toBe(true); // the stalled fetch is told to stop

    await advance(DELAY);
    expect(run).toHaveBeenCalledTimes(2); // and the loop is alive

    await advance(TIMEOUT + DELAY);
    expect(run).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("keeps polling when a cycle throws synchronously", async () => {
    const run = vi.fn(() => {
      throw new Error("boom");
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    await advance(DELAY);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("keeps polling when a cycle rejects", async () => {
    const run = vi.fn(async () => {
      throw new Error("offline");
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    await advance(DELAY);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("does not abort a cycle that finishes inside its deadline", async () => {
    let seen: AbortSignal | null = null;
    const run = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise((r) => setTimeout(r, 1_000));
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await advance(1_000);
    await advance(TIMEOUT); // well past the deadline the cycle beat
    expect(seen!.aborted).toBe(false);
    loop.stop();
  });
});

describe("startVisibleLoop — visibility", () => {
  it("does not poll while hidden, and polls at once on return", async () => {
    const run = vi.fn();
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT, hiddenAtStart: true });
    await advance(DELAY * 3);
    expect(run).toHaveBeenCalledTimes(0);

    loop.setHidden(false);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("aborts the cycle in flight when the panel goes dark", async () => {
    let seen: AbortSignal | null = null;
    const run = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise((r) => setTimeout(r, 5_000));
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    loop.setHidden(true);
    expect(seen!.aborted).toBe(true);
    loop.stop();
  });

  it("DOES NOT FORK THE LOOP when the panel blanks and wakes mid-cycle", async () => {
    // The second production bug: a resume started a fresh cycle while the old
    // one was still awaiting, and when the old one settled it scheduled a tick
    // of its own. Every hide→show flap doubled the polling rate, forever.
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 3_000));
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    // Blank and wake three times while cycle 1 is in flight.
    for (let i = 0; i < 3; i++) {
      loop.setHidden(true);
      await flush();
      loop.setHidden(false);
      await flush();
    }
    const afterFlaps = run.mock.calls.length;

    // Two full cadences later there must be exactly two more cycles — not six,
    // not eight.
    await advance(3_000 + DELAY);
    await advance(3_000 + DELAY);
    expect(run).toHaveBeenCalledTimes(afterFlaps + 2);
    loop.stop();
  });
});

describe("startVisibleLoop — stop", () => {
  it("stops polling and aborts what is in flight", async () => {
    let seen: AbortSignal | null = null;
    const run = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise((r) => setTimeout(r, 5_000));
    });
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    loop.stop();
    expect(seen!.aborted).toBe(true);

    await advance(DELAY * 4);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores a visibility change after it has stopped", async () => {
    const run = vi.fn();
    const loop = startVisibleLoop({ run, delayMs: DELAY, timeoutMs: TIMEOUT });
    await flush();
    loop.stop();
    loop.setHidden(false);
    await advance(DELAY * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
