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
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";

const CACHE_KEY = "track-status:cache:v1";
const LOCK_KEY = "track-status:lock";
const PAYLOAD = { megaTrackEnabled: false, tracks: [{ trackName: "Blue Track" }] };

/** Seed the cache as though the last good read happened `ageMs` ago. */
function seedCache(ageMs: number, data: unknown = PAYLOAD) {
  store.set(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now() - ageMs, data }));
}

/**
 * Pin the dayplanner tier of the synthetic answer, so these tests are
 * deterministic on every weekday — without this, the ladder's Tuesday
 * calendar fallback would flip the expected verdict once a week.
 */
function seedDayPlannerVerdict(isMegaDay: boolean) {
  store.set(`mega-day:${businessDayYmdET()}`, isMegaDay ? "1" : "0");
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
    // and it must come back because OUR timeout fired. It now comes back
    // as a SYNTHETIC answer — the mega ladder — rather than a 502 the
    // client hook would discard.
    seedDayPlannerVerdict(false);
    const upstream = hangingUpstream();
    vi.stubGlobal("fetch", upstream);

    const started = Date.now();
    const res = await GET();
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("SYNTH-ERROR");
    expect(res.headers.get("X-Upstream-Error")).toContain("aborted");
    // toMatchObject, not toEqual: our own `onTime` block rides along on every
    // response now (see the route header). The upstream-shaped fields are what
    // this test is about.
    await expect(res.json()).resolves.toMatchObject({
      megaTrackEnabled: false,
      tracks: [],
      degraded: true,
    });
    // Proves the abort came from the route's own signal, not from waiting
    // out the function duration.
    expect(upstream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it("serves the last known reading when upstream fails, instead of erroring", async () => {
    // Stale past FRESH_MS (30s) but well inside MAX_SERVE_AGE_MS.
    seedCache(90_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE-ERROR");
    expect(res.headers.get("X-Upstream-Error")).toContain("aborted");
    await expect(res.json()).resolves.toMatchObject(PAYLOAD);
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

  it("carries the widget through a multi-hour outage", async () => {
    // 2h40m. The 2026-08-13 outage blanked the widget twice by aging the
    // cached reading out from under it; the call was to keep showing the
    // last real reading for the whole plausible length of an outage.
    seedCache(160 * 60_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE-ERROR");
  });

  it("refuses to state a reading older than the serve cap — and synthesizes instead", async () => {
    // 5 hours — older than the centre has been open. That is not a delay
    // figure any more, and stating it would be a wrong answer stated
    // confidently. The route now answers the one question it CAN still
    // answer (mega mode, via the ladder) with an empty delay list.
    seedDayPlannerVerdict(false);
    seedCache(5 * 60 * 60_000);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("SYNTH-ERROR");
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.tracks).toEqual([]); // never the fossil reading
  });

  it("the synthetic answer rides the mega ladder — a dayplanner mega day reads as mega", async () => {
    // Status app dark, no cache, no mega heat called yet — but BMI's
    // dayplanner says today is a Mega day. The degraded payload must say so,
    // which is what keeps the boards in mega layout through a status outage.
    seedDayPlannerVerdict(true);
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.megaTrackEnabled).toBe(true);
    expect(body.degraded).toBe(true);
  });

  it("keeps Redis retention above the serve cap", async () => {
    // Guards the shape of the original bug: if the key is evicted before
    // the cap is reached, the cap is decorative and the route is back to
    // having nothing to fall back to. Asserted on the real SET arguments.
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

    await GET();

    const setCall = vi.mocked(redis.set).mock.calls.find((c) => c[0] === CACHE_KEY) as unknown as [
      string,
      string,
      string,
      number,
    ];
    expect(setCall).toBeDefined();
    expect(setCall[2]).toBe("EX");
    // Retention (sec) must exceed the serve cap (ms) with headroom.
    expect(setCall[3] * 1000).toBeGreaterThan(3 * 60 * 60_000);
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
    // And the fresh reading is now cached for everyone else. toEqual, not
    // toMatchObject: what goes in the CACHE must stay the upstream payload
    // alone — freezing our block behind the upstream's 3-hour serve ceiling
    // would serve tonight's on-time picture from this afternoon.
    expect(JSON.parse(store.get(CACHE_KEY)!).data).toEqual(PAYLOAD);
  });
});

/**
 * OUR OWN on-time block (2026-08-17). The contract is ADDITIVE: whatever the
 * upstream said still arrives untouched, so nothing reading `tracks[]` can break.
 */
describe("GET /api/track-status — the onTime block", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    seedDayPlannerVerdict(false);
    delete process.env.ONTIME_OWN_SOURCE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ONTIME_OWN_SOURCE;
  });

  it("rides along on a cache HIT without disturbing the upstream fields", async () => {
    seedCache(1_000);

    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body.megaTrackEnabled).toBe(false);
    expect(body.tracks).toEqual(PAYLOAD.tracks);
    expect(body.onTime).toBeTruthy();
  });

  it("reports slot coverage, so a surface can refuse to score a thin night", async () => {
    seedCache(1_000);

    const body = (await (await GET()).json()) as {
      onTime: { slotCoverage: { withSlot: number; total: number }; businessDay: string };
    };

    // No DB in this environment ⇒ zero heats. The point is that the field EXISTS
    // and reads zero rather than being absent, which is what lets a board say
    // "not enough measured yet" instead of a confident "On Time".
    expect(body.onTime.slotCoverage).toEqual({ withSlot: 0, total: 0 });
    expect(body.onTime.businessDay).toBe(businessDayYmdET());
  });

  it("survives a dark upstream — it is computed from OUR archives", async () => {
    vi.stubGlobal("fetch", abortingUpstream());

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.headers.get("X-Cache")).toBe("SYNTH-ERROR");
    expect(body.degraded).toBe(true);
    expect(body.onTime).toBeTruthy();
  });

  it("KILL SWITCH: ONTIME_OWN_SOURCE=false drops the block and nothing else", async () => {
    process.env.ONTIME_OWN_SOURCE = "false";
    seedCache(1_000);

    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body.onTime).toBeUndefined();
    // The route is exactly what it was before this feature existed.
    expect(body).toEqual(PAYLOAD);
  });

  it("is ON by default — a merged feature is on, per the flags rule", async () => {
    delete process.env.ONTIME_OWN_SOURCE;
    seedCache(1_000);

    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body.onTime).toBeTruthy();
  });

  it("does not treat any other value as off", async () => {
    process.env.ONTIME_OWN_SOURCE = "0";
    seedCache(1_000);

    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body.onTime).toBeTruthy();
  });
});
