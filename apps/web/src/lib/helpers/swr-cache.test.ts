import { describe, expect, it, vi } from "vitest";
import { createSwrCache } from "./swr-cache";

/** A scheduler that captures the work so a test can run it when it chooses. */
function capturingScheduler() {
  const queue: Array<() => Promise<unknown>> = [];
  return {
    schedule: (work: () => Promise<unknown>) => {
      queue.push(work);
    },
    /** Run everything queued so far, in order. */
    flush: async () => {
      const work = queue.splice(0);
      for (const w of work) await w();
    },
    pending: () => queue.length,
  };
}

function setup(opts?: { maxStaleMs?: number | null; retryAfterMs?: number }) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const sched = capturingScheduler();
  const load = vi.fn<(key: string) => Promise<string>>();
  const cache = createSwrCache<string>({
    ttlMs: 30_000,
    maxStaleMs: opts?.maxStaleMs,
    retryAfterMs: opts?.retryAfterMs,
    load,
    schedule: sched.schedule,
    now: clock.now,
  });
  return { cache, load, sched, clock };
}

describe("createSwrCache", () => {
  it("cold: awaits the load and serves it fresh afterwards without loading again", async () => {
    const { cache, load, sched } = setup();
    load.mockResolvedValueOnce("a");
    expect(await cache.read("k")).toBe("a");
    expect(await cache.read("k")).toBe("a");
    expect(load).toHaveBeenCalledTimes(1);
    expect(sched.pending()).toBe(0);
  });

  it("stale: serves the old value immediately and refreshes in the background once", async () => {
    const { cache, load, sched, clock } = setup();
    load.mockResolvedValueOnce("a");
    await cache.read("k");
    clock.advance(31_000);

    load.mockResolvedValueOnce("b");
    // Three polls land on the stale value; only ONE refresh is scheduled.
    expect(await cache.read("k")).toBe("a");
    expect(await cache.read("k")).toBe("a");
    expect(await cache.read("k")).toBe("a");
    expect(sched.pending()).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    await sched.flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(await cache.read("k")).toBe("b");
    expect(sched.pending()).toBe(0);
  });

  it("a failed background refresh keeps serving the last-good value and waits out the retry window", async () => {
    const { cache, load, sched, clock } = setup({ retryAfterMs: 10_000 });
    load.mockResolvedValueOnce("a");
    await cache.read("k");
    clock.advance(31_000);

    load.mockRejectedValueOnce(new Error("portal 503"));
    expect(await cache.read("k")).toBe("a");
    await sched.flush();
    expect(load).toHaveBeenCalledTimes(2);

    // Inside the retry window: stale value, NO new attempt.
    clock.advance(5_000);
    expect(await cache.read("k")).toBe("a");
    expect(sched.pending()).toBe(0);

    // Window over: one more background attempt.
    clock.advance(6_000);
    load.mockResolvedValueOnce("c");
    expect(await cache.read("k")).toBe("a");
    expect(sched.pending()).toBe(1);
    await sched.flush();
    expect(await cache.read("k")).toBe("c");
  });

  it("past maxStaleMs the value is no longer served — the read awaits a load like a cold one", async () => {
    const { cache, load, clock } = setup({ maxStaleMs: 60_000 });
    load.mockResolvedValueOnce("a");
    await cache.read("k");
    // ttl 30s + maxStale 60s = 90s. At 100s it is too old to stand.
    clock.advance(100_000);
    load.mockResolvedValueOnce("fresh");
    expect(await cache.read("k")).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("cold + recently failed: rethrows the remembered error instead of re-asking the upstream", async () => {
    const { cache, load, clock } = setup({ retryAfterMs: 30_000 });
    const boom = new Error("portal 404");
    load.mockRejectedValueOnce(boom);
    await expect(cache.read("k")).rejects.toBe(boom);
    clock.advance(1_000);
    await expect(cache.read("k")).rejects.toBe(boom);
    expect(load).toHaveBeenCalledTimes(1);

    clock.advance(30_000);
    load.mockResolvedValueOnce("back");
    expect(await cache.read("k")).toBe("back");
  });

  it("a new key is cold even while the old key's value is fresh", async () => {
    const { cache, load } = setup();
    load.mockResolvedValueOnce("mon");
    expect(await cache.read("2026-09-11")).toBe("mon");
    load.mockResolvedValueOnce("tue");
    expect(await cache.read("2026-09-12")).toBe("tue");
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek()?.key).toBe("2026-09-12");
  });

  it("concurrent cold readers share one load", async () => {
    const { cache, load } = setup();
    let resolve!: (v: string) => void;
    load.mockImplementationOnce(() => new Promise<string>((r) => (resolve = r)));
    const a = cache.read("k");
    const b = cache.read("k");
    resolve("shared");
    expect(await Promise.all([a, b])).toEqual(["shared", "shared"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("an explicit `now` argument drives the freshness test", async () => {
    const { cache, load, sched, clock } = setup();
    load.mockResolvedValueOnce("a");
    await cache.read("k", clock.now());
    // Same instant → fresh. A caller's later timestamp → stale, background refresh.
    expect(await cache.read("k", clock.now())).toBe("a");
    expect(sched.pending()).toBe(0);
    expect(await cache.read("k", clock.now() + 31_000)).toBe("a");
    expect(sched.pending()).toBe(1);
  });
});
