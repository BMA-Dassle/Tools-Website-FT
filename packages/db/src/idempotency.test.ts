import { describe, expect, it, vi } from "vitest";
import { withIdempotency, type IdempotencyRedis } from "./idempotency";

/** In-memory Redis stub conforming to the IdempotencyRedis interface. */
function makeFakeRedis(initial: Record<string, string> = {}): IdempotencyRedis & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
  };
}

describe("withIdempotency", () => {
  it("invokes fn and caches the result on first call", async () => {
    const redis = makeFakeRedis();
    const fn = vi.fn(async () => ({ codes: ["A", "B", "C"], creditAtClaim: 30 }));

    const result = await withIdempotency(redis, "pov:claimed:person:123", fn);

    expect(result).toEqual({ codes: ["A", "B", "C"], creditAtClaim: 30 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(redis.store.get("pov:claimed:person:123")).toBe(
      JSON.stringify({ codes: ["A", "B", "C"], creditAtClaim: 30 }),
    );
  });

  it("returns cached value on second call without invoking fn", async () => {
    const redis = makeFakeRedis({
      "pov:claimed:person:123": JSON.stringify({ codes: ["A", "B", "C"] }),
    });
    const fn = vi.fn(async () => {
      throw new Error("fn must not be called when cache exists");
    });

    const result = await withIdempotency(redis, "pov:claimed:person:123", fn);

    expect(result).toEqual({ codes: ["A", "B", "C"] });
    expect(fn).not.toHaveBeenCalled();
  });

  it("does NOT cache when fn throws", async () => {
    const redis = makeFakeRedis();
    const fn = vi.fn(async () => {
      throw new Error("allocation failed");
    });

    await expect(withIdempotency(redis, "k1", fn)).rejects.toThrow("allocation failed");
    expect(redis.store.has("k1")).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("annotates cached results with { cached: true } when opt enabled", async () => {
    const redis = makeFakeRedis({
      k1: JSON.stringify({ codes: ["X"] }),
    });
    const fn = vi.fn();

    const result = await withIdempotency(redis, "k1", fn, { annotateCached: true });

    expect(result).toEqual({ codes: ["X"], cached: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes ttl to redis.set via ioredis-style positional args", async () => {
    const redis = makeFakeRedis();
    const fn = vi.fn(async () => "result");

    await withIdempotency(redis, "k1", fn, { ttlSeconds: 600 });

    expect(redis.set).toHaveBeenCalledWith("k1", JSON.stringify("result"), "EX", 600, { ex: 600 });
  });

  it("uses 90-day default ttl when not specified", async () => {
    const redis = makeFakeRedis();
    await withIdempotency(redis, "k1", async () => "x");
    const NINETY_DAYS = 90 * 24 * 60 * 60;
    expect(redis.set).toHaveBeenCalledWith("k1", expect.any(String), "EX", NINETY_DAYS, {
      ex: NINETY_DAYS,
    });
  });
});
