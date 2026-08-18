import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The league cache has two jobs and they fail in opposite directions, so both
 * are pinned here:
 *
 *   - Serving a copy that is too old would switch /api/cron/level-up-watch off:
 *     it only reacts to sessions that finished in the last ten minutes, so the
 *     fresh window has to be honoured exactly, per caller.
 *   - Serving NOTHING when Pandora is down is what put 123 × 500 on this route
 *     during the 2026-08-18 degradation. A retained copy, however old, beats an
 *     error page — and must be handed over with the reason attached.
 */

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  }),
};
vi.mock("@/lib/redis", () => ({ default: redisMock }));

const {
  FRESH_WINDOW_MS,
  __resetFreezeMemo,
  isLeaguePullFrozen,
  leagueCacheHeaders,
  leagueReadThrough,
} = await import("./pandora-cache");

const PATH = "/v2/bmi/records/standings/LAB52GY480CJF?startDate=x&scoreGroupName=Blue%20Pro";
const KEY = `pandora:leagues:v1:${PATH}`;

/** Seed a copy of `body` that Redis will report as `ageMs` old. */
function seed(body: string, ageMs: number, status = 200) {
  store.set(KEY, JSON.stringify({ status, body, cachedAt: Date.now() - ageMs }));
}

const ok = (body: string) => vi.fn(async () => ({ status: 200, body }));

beforeEach(() => {
  store.clear();
  redisMock.get.mockClear();
  redisMock.set.mockClear();
  __resetFreezeMemo();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("leagueReadThrough — fresh window", () => {
  it("answers from Redis without touching Pandora inside the window", async () => {
    seed('{"success":true,"data":[{"persId":1}]}', 30 * 60_000);
    const fetcher = ok("SHOULD NOT BE CALLED");

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(r.source).toBe("cache");
    expect(r.json).toEqual({ success: true, data: [{ persId: 1 }] });
    expect(r.ageMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("goes live once the copy is older than the window, and writes through", async () => {
    seed('{"success":true,"data":[]}', 61 * 60_000);
    const fetcher = ok('{"success":true,"data":[{"persId":2}]}');

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r.source).toBe("fresh");
    expect(r.ageMs).toBeNull();
    expect(JSON.parse(store.get(KEY)!).body).toBe('{"success":true,"data":[{"persId":2}]}');
  });

  it("keeps the live reads on a 60s window — a 2-minute-old session list is NOT served", async () => {
    // The level-up cron runs every 2 min against a 10-minute relevance window;
    // anything longer than its own interval hides finishes from it.
    seed('{"data":[{"sessionId":1}]}', 2 * 60_000);
    const fetcher = ok('{"data":[{"sessionId":1},{"sessionId":2}]}');

    const r = await leagueReadThrough({ path: PATH, freshForMs: FRESH_WINDOW_MS.live, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r.source).toBe("fresh");
  });

  it("fresh=1 bypasses a copy that is still inside the window", async () => {
    seed('{"success":true,"data":[]}', 5_000);
    const fetcher = ok('{"success":true,"data":[{"persId":3}]}');

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      forceFresh: true,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r.source).toBe("fresh");
  });
});

describe("leagueReadThrough — the outage path", () => {
  it("serves the retained copy when Pandora 500s, with the reason attached", async () => {
    seed('{"success":true,"data":[{"persId":4}]}', 5 * 60 * 60_000); // 5h old
    const fetcher = vi.fn(async () => ({ status: 500, body: "Server Error" }));

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher,
    });

    expect(r.status).toBe(200);
    expect(r.source).toBe("stale");
    expect(r.staleReason).toBe("pandora-500");
    expect(r.json).toEqual({ success: true, data: [{ persId: 4 }] });
    expect(leagueCacheHeaders(r)["X-Cache"]).toBe("STALE-pandora-500");
  });

  it("serves the retained copy when the request times out", async () => {
    seed('{"success":true,"data":[{"persId":5}]}', 90 * 60_000);
    const fetcher = vi.fn(async () => {
      throw new Error("Timeout");
    });

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher,
    });

    expect(r.source).toBe("stale");
    expect(r.staleReason).toBe("Timeout");
    expect(r.status).toBe(200);
  });

  it("falls back to stale even when the caller asked for fresh=1", async () => {
    seed('{"success":true,"data":[{"persId":6}]}', 10_000);
    const fetcher = vi.fn(async () => ({ status: 502, body: "Bad Gateway" }));

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      forceFresh: true,
      fetcher,
    });

    expect(r.source).toBe("stale");
    expect(r.json).toEqual({ success: true, data: [{ persId: 6 }] });
  });

  it("passes the failure through when there is nothing cached to serve", async () => {
    const fetcher = vi.fn(async () => ({ status: 503, body: "upstream down" }));

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher,
    });

    expect(r.status).toBe(503);
    expect(r.json).toBeNull();
    expect(r.body).toBe("upstream down");
    expect(store.has(KEY)).toBe(false);
  });

  it("never caches a 200 that isn't JSON, and prefers the older real answer", async () => {
    seed('{"success":true,"data":[{"persId":7}]}', 3 * 60 * 60_000);
    const fetcher = ok("<html>Application Error</html>");

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher,
    });

    expect(r.source).toBe("stale");
    expect(r.staleReason).toBe("unparseable");
    expect(r.json).toEqual({ success: true, data: [{ persId: 7 }] });
    // The junk did not overwrite the good copy.
    expect(JSON.parse(store.get(KEY)!).body).toBe('{"success":true,"data":[{"persId":7}]}');
  });

  it("reports 502 for an unparseable 200 with no copy to fall back on", async () => {
    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher: ok("<html>Application Error</html>"),
    });

    expect(r.status).toBe(502);
    expect(r.json).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });
});

describe("leagueReadThrough — keying", () => {
  it("keys on the upstream path, so a different score group cannot read this copy", async () => {
    seed('{"success":true,"data":[{"persId":8}]}', 60_000);
    const other = PATH.replace("Blue%20Pro", "Red%20Pro");
    const fetcher = ok('{"success":true,"data":[]}');

    await leagueReadThrough({ path: other, freshForMs: FRESH_WINDOW_MS.standings, fetcher });

    expect(fetcher).toHaveBeenCalledWith(other);
    expect(redisMock.get).toHaveBeenCalledWith(`pandora:leagues:v1:${other}`);
  });

  it("survives a Redis read that throws — the live answer still goes out", async () => {
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      fetcher: ok('{"success":true,"data":[{"persId":9}]}'),
    });

    expect(r.source).toBe("fresh");
    expect(r.json).toEqual({ success: true, data: [{ persId: 9 }] });
  });
});

describe("leagueReadThrough — the ops freeze", () => {
  it("serves a copy of ANY age and never calls Pandora", async () => {
    seed('{"success":true,"data":[{"persId":10}]}', 20 * 24 * 60 * 60_000); // 20 days
    const fetcher = ok("SHOULD NOT BE CALLED");

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      pullEnabled: false,
      fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(r.source).toBe("frozen");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: true, data: [{ persId: 10 }] });
    expect(leagueCacheHeaders(r)["X-Cache"]).toBe("FROZEN");
  });

  it("fresh=1 does NOT punch through the freeze", async () => {
    seed('{"success":true,"data":[{"persId":11}]}', 5 * 60 * 60_000);
    const fetcher = ok('{"success":true,"data":[{"persId":999}]}');

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      pullEnabled: false,
      forceFresh: true,
      fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(r.json).toEqual({ success: true, data: [{ persId: 11 }] });
  });

  it("503s rather than quietly reopening the tap on a cold key", async () => {
    const fetcher = ok('{"success":true,"data":[]}');

    const r = await leagueReadThrough({
      path: PATH,
      freshForMs: FRESH_WINDOW_MS.standings,
      pullEnabled: false,
      fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(r.status).toBe(503);
    expect(r.source).toBe("frozen");
    expect(leagueCacheHeaders(r)["X-Cache"]).toBe("FROZEN-no-cached-copy");
  });
});

describe("isLeaguePullFrozen", () => {
  it("is false when the switch key is absent", async () => {
    expect(await isLeaguePullFrozen()).toBe(false);
  });

  it("is true once the switch key is set", async () => {
    store.set("pandora:leagues:pull-frozen", new Date().toISOString());
    expect(await isLeaguePullFrozen()).toBe(true);
  });

  it("treats an explicit 0/false as not frozen, so the key can be parked", async () => {
    store.set("pandora:leagues:pull-frozen", "false");
    expect(await isLeaguePullFrozen()).toBe(false);
  });

  it("FAILS OPEN — a dead Redis pulls live rather than serving nothing", async () => {
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    expect(await isLeaguePullFrozen()).toBe(false);
  });

  it("memoises, so a cache hit doesn't pay a Redis round trip per request", async () => {
    store.set("pandora:leagues:pull-frozen", "1");
    expect(await isLeaguePullFrozen()).toBe(true);
    const reads = redisMock.get.mock.calls.length;
    expect(await isLeaguePullFrozen()).toBe(true);
    expect(redisMock.get.mock.calls.length).toBe(reads);
  });
});

describe("leagueCacheHeaders", () => {
  it("labels a live answer FRESH with no age", () => {
    const h = leagueCacheHeaders({
      status: 200,
      body: "{}",
      json: {},
      source: "fresh",
      staleReason: null,
      ageMs: null,
    });
    expect(h["X-Cache"]).toBe("FRESH");
    expect(h["X-Cache-Age"]).toBeUndefined();
    expect(h["Cache-Control"]).toBe("no-store");
  });

  it("reports a cached answer's age in seconds", () => {
    const h = leagueCacheHeaders({
      status: 200,
      body: "{}",
      json: {},
      source: "cache",
      staleReason: null,
      ageMs: 90_400,
    });
    expect(h["X-Cache"]).toBe("CACHE");
    expect(h["X-Cache-Age"]).toBe("90");
  });
});
