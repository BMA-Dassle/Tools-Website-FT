import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A tiny in-memory stand-in for the Redis keyspace this route uses, so the
// lock semantics under test are the real ones (SET NX wins once, the Lua
// release only fires for the matching token) rather than mocked away.
const store = new Map<string, string>();

vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === "NX" && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  },
}));

import { GET } from "./route";

const CACHE_KEY = "track-status:cache:v1";
const LOCK_KEY = "track-status:lock";
const PAYLOAD = { megaTrackEnabled: false, tracks: [{ trackName: "Blue Track" }] };

/** Seed the cache as though the last good read happened `ageMs` ago. */
function seedCache(ageMs: number, data: unknown = PAYLOAD) {
  store.set(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now() - ageMs, data }));
}

/**
 * An upstream that never answers — the 2026-08-13 failure, exactly. Only
 * the timing test uses this, because it costs a real UPSTREAM_TIMEOUT_MS
 * to resolve; the fallback tests use `abortingUpstream` instead.
 */
function hangingUpstream() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
        );
      }) as Promise<Response>,
  );
}

/**
 * The same rejection a timed-out fetch produces, raised immediately.
 * Shape verified against a real `fetch(..., { signal: AbortSignal.timeout })`
 * on Node 22: a DOMException named TimeoutError, `instanceof Error` true.
 */
function abortingUpstream() {
  return vi.fn(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
}

beforeEach(() => {
  store.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/track-status", () => {
  it("serves fresh cache without touching upstream", async () => {
    seedCache(5_000);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bounds the upstream call so a hung upstream cannot pin the lock holder", async () => {
    // No cache at all, upstream hangs: the request must still come back,
    // and it must come back because OUR timeout fired.
    const upstream = hangingUpstream();
    vi.stubGlobal("fetch", upstream);

    const started = Date.now();
    const res = await GET();
    const elapsed = Date.now() - started;

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: "The operation was aborted due to timeout",
    });
    // Proves the abort came from the route's own signal, not from waiting
    // out the function duration.
    expect(upstream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it("serves the last known reading when upstream fails, instead of erroring", async () => {
    // Stale past FRESH_MS (30s) but well inside MAX_SERVE_AGE_MS (10m).
    seedCache(90_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE-ERROR");
    expect(res.headers.get("X-Upstream-Error")).toContain("aborted");
    await expect(res.json()).resolves.toEqual(PAYLOAD);
  });

  it("survives an outage longer than the old 60s cache TTL — the 503-storm regression", async () => {
    // This is the case that produced 78 × 503 in two hours: upstream down
    // for minutes. Retention must outlive the outage so there is still a
    // last-known value to fall back to.
    seedCache(5 * 60_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE-ERROR");
  });

  it("still serves a reading 40 minutes old — inside the raised cap", async () => {
    // The 2026-08-13 outage ran past the original 10-minute cap and blanked
    // the widget while upstream was still down. At this age a stale number
    // beats no number, so this must NOT fall through to an error.
    seedCache(40 * 60_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE-ERROR");
  });

  it("refuses to state a reading older than the serve cap", async () => {
    // 90 minutes — roughly seven heats ago. Track delay turns over every
    // heat, so this is not degraded service, it would be a wrong answer
    // stated confidently.
    seedCache(90 * 60_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(502);
    expect(res.headers.get("X-Cache")).not.toBe("STALE-ERROR");
  });

  it("serves stale rather than dog-piling when another instance holds the lock", async () => {
    seedCache(90_000);
    store.set(LOCK_KEY, "someone-elses-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE-LOCKED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves another instance's lock alone when its own has expired", async () => {
    // The unsafe-unlock case: our lock expires mid-flight and a second
    // instance legitimately takes it. Our `finally` must not free theirs.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        store.set(LOCK_KEY, "second-instance-token"); // TTL elapsed, they won it
        return new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await GET();

    expect(res.status).toBe(200);
    expect(store.get(LOCK_KEY)).toBe("second-instance-token");
  });

  it("releases its own lock on the happy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(PAYLOAD), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(store.has(LOCK_KEY)).toBe(false);
    // And the fresh reading is now cached for everyone else.
    expect(JSON.parse(store.get(CACHE_KEY)!).data).toEqual(PAYLOAD);
  });
});
