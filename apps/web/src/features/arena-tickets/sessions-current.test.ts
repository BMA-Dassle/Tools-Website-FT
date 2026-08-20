import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The rule under test is the one that matters: a last-known-good list is served
 * to a DISPLAY and never to a SENDER. Everything else here is caching.
 */

const store = new Map<string, string>();
const get = vi.fn(async (k: string) => store.get(k) ?? null);
const set = vi.fn(async (k: string, v: string) => {
  store.set(k, v);
  return "OK";
});

vi.mock("@/lib/redis", () => ({ default: { get, set } }));
vi.mock("server-only", () => ({}));

const CENTER = { locationId: "TXBSQN0FEKQ11", label: "HP FM" } as never;
const SESSION = {
  sessionId: "123",
  resourceName: "HP Arena",
  type: "Nexus Laser Tag",
  heatNumber: 4,
  scheduledStart: "2026-08-19T22:00:00Z",
  calledAt: "2026-08-19T21:45:00Z",
};

async function load() {
  return await import("./sessions-current.server");
}

beforeEach(() => {
  store.clear();
  get.mockClear();
  set.mockClear();
  vi.resetModules();
  process.env.SWAGGER_ADMIN_KEY = "test";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("calledArenaSessions", () => {
  it("returns the live list and writes both the serving copy and the LKG", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [SESSION] }), { status: 200 }));
    const { calledArenaSessions } = await load();
    const r = await calledArenaSessions(CENTER);
    expect(r.sessions).toHaveLength(1);
    expect(r.stale).toBe(false);
    // one short-lived serving copy, one long-lived floor
    const keys = set.mock.calls.map((c) => String(c[0]));
    expect(keys).toContain("pandora:sessions-current:TXBSQN0FEKQ11");
    expect(keys).toContain("pandora:sessions-current:lkg:TXBSQN0FEKQ11");
  });

  it("serves the cache without touching Pandora — this is what collapses readers", async () => {
    const f = vi.fn(() => new Response(JSON.stringify({ data: [SESSION] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const { calledArenaSessions } = await load();
    await calledArenaSessions(CENTER);
    await calledArenaSessions(CENTER);
    await calledArenaSessions(CENTER);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("A DISPLAY gets the last-known-good list when the read fails", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [SESSION] }), { status: 200 }));
    const { calledArenaSessions } = await load();
    await calledArenaSessions(CENTER); // seeds the LKG
    store.delete("pandora:sessions-current:TXBSQN0FEKQ11"); // serving copy expires
    stubFetch(() => {
      throw new Error("timeout");
    });
    const r = await calledArenaSessions(CENTER, { allowStale: true });
    expect(r.sessions).toHaveLength(1);
    expect(r.stale).toBe(true);
  });

  it("A SENDER gets an EMPTY list when the read fails, never the stale one", async () => {
    // The whole point: this cron texts guests "you're checking in now", and a
    // stale list could say that about a session that already finished.
    stubFetch(() => new Response(JSON.stringify({ data: [SESSION] }), { status: 200 }));
    const { calledArenaSessions } = await load();
    await calledArenaSessions(CENTER); // LKG now holds a session
    store.delete("pandora:sessions-current:TXBSQN0FEKQ11");
    stubFetch(() => {
      throw new Error("timeout");
    });
    const r = await calledArenaSessions(CENTER); // no allowStale — the default
    expect(r.sessions).toEqual([]);
    expect(r.stale).toBe(false);
  });

  it("treats a non-200 as a failure, not as an empty arena", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [SESSION] }), { status: 200 }));
    const { calledArenaSessions } = await load();
    await calledArenaSessions(CENTER);
    store.delete("pandora:sessions-current:TXBSQN0FEKQ11");
    stubFetch(() => new Response("nope", { status: 503 }));
    const r = await calledArenaSessions(CENTER, { allowStale: true });
    expect(r.stale).toBe(true);
    expect(r.sessions).toHaveLength(1);
  });

  it("never writes an LKG from a failed read", async () => {
    stubFetch(() => {
      throw new Error("timeout");
    });
    const { calledArenaSessions } = await load();
    const r = await calledArenaSessions(CENTER, { allowStale: true });
    expect(r.sessions).toEqual([]);
    expect(set).not.toHaveBeenCalled();
  });

  it("returns empty rather than throwing when there is no LKG to fall back to", async () => {
    stubFetch(() => {
      throw new Error("timeout");
    });
    const { calledArenaSessions } = await load();
    await expect(calledArenaSessions(CENTER, { allowStale: true })).resolves.toEqual({
      sessions: [],
      stale: false,
    });
  });

  it("survives a malformed cache entry by going upstream", async () => {
    store.set("pandora:sessions-current:TXBSQN0FEKQ11", "{not json");
    stubFetch(() => new Response(JSON.stringify({ data: [SESSION] }), { status: 200 }));
    const { calledArenaSessions } = await load();
    const r = await calledArenaSessions(CENTER);
    expect(r.sessions).toHaveLength(1);
  });
});
