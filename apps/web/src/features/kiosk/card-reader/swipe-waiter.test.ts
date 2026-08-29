import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwipeWaiter, DEFAULT_SWIPE_WAIT_MS, SwipeWaitError } from "./swipe-waiter";

describe("createSwipeWaiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("feed() with nobody waiting returns false so the caller's normal handling runs", () => {
    const w = createSwipeWaiter();
    expect(w.feed("1037356")).toBe(false);
    expect(w.waiting).toBe(false);
  });

  it("resolves the pending wait with the fed account and reports it consumed", async () => {
    const w = createSwipeWaiter();
    const p = w.wait({ timeoutMs: 90_000 });
    expect(w.waiting).toBe(true);
    expect(w.feed("0000000001037356")).toBe(true);
    await expect(p).resolves.toBe("0000000001037356");
    expect(w.waiting).toBe(false);
    // The swipe was consumed — a second feed has nobody to give it to.
    expect(w.feed("999")).toBe(false);
  });

  it("times out — a walk-away guest never leaves the screen listening", async () => {
    const w = createSwipeWaiter();
    const p = w.wait({ timeoutMs: 90_000 });
    const rejected = expect(p).rejects.toMatchObject({ kind: "timeout" });
    vi.advanceTimersByTime(90_000);
    await rejected;
    expect(w.waiting).toBe(false);
    // A late swipe after the timeout is NOT swallowed by the dead wait.
    expect(w.feed("123")).toBe(false);
  });

  it("cancel() rejects only the pending wait and the instance stays usable", async () => {
    const w = createSwipeWaiter();
    const p = w.wait({ timeoutMs: 1_000 });
    w.cancel();
    await expect(p).rejects.toBeInstanceOf(SwipeWaitError);
    await expect(p).rejects.toMatchObject({ kind: "cancelled" });
    // Cancelled wait's timer is gone — advancing time must not throw or fire.
    vi.advanceTimersByTime(5_000);
    // Reusable (StrictMode remounts reuse the same ref'd instance).
    const p2 = w.wait({ timeoutMs: 1_000 });
    expect(w.feed("42")).toBe(true);
    await expect(p2).resolves.toBe("42");
  });

  it("cancel() with nothing pending is a no-op", () => {
    const w = createSwipeWaiter();
    expect(() => w.cancel()).not.toThrow();
  });

  it("an AbortSignal cancels the wait", async () => {
    const w = createSwipeWaiter();
    const ac = new AbortController();
    const p = w.wait({ timeoutMs: 10_000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: "cancelled" });
    expect(w.waiting).toBe(false);
  });

  it("a wait with no explicit timeout is still bounded (DEFAULT_SWIPE_WAIT_MS)", async () => {
    const w = createSwipeWaiter();
    const p = w.wait();
    const rejected = expect(p).rejects.toMatchObject({ kind: "timeout" });
    vi.advanceTimersByTime(DEFAULT_SWIPE_WAIT_MS - 1);
    expect(w.waiting).toBe(true);
    vi.advanceTimersByTime(1);
    await rejected;
  });

  it("an already-aborted signal rejects immediately", async () => {
    const w = createSwipeWaiter();
    const ac = new AbortController();
    ac.abort();
    await expect(w.wait({ signal: ac.signal })).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("a second wait() cancels the first — a stale awaiter can never steal a later swipe", async () => {
    const w = createSwipeWaiter();
    const first = w.wait({ timeoutMs: 10_000 });
    const second = w.wait({ timeoutMs: 10_000 });
    await expect(first).rejects.toMatchObject({ kind: "cancelled" });
    expect(w.feed("777")).toBe(true);
    await expect(second).resolves.toBe("777");
  });
});
