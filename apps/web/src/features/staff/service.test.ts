import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The rules that matter are the ones a briefing room feels at 9pm:
 *   - a hit never touches 7shifts,
 *   - a new hire becomes typeable without waiting out the cache,
 *   - a mistyped id cannot stampede the API,
 *   - and 7shifts falling over does not brick a tablet mid-shift.
 */

// ── a small in-memory Redis ────────────────────────────────────────────────
const hashes = new Map<string, Map<string, string>>();
const sets = new Map<string, Set<string>>();
const strings = new Map<string, string>();
const ttls = new Map<string, number>();

const fake = {
  hget: vi.fn(async (k: string, f: string) => hashes.get(k)?.get(f) ?? null),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = hashes.get(k) ?? new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
    hashes.set(k, h);
    return args.length / 2;
  }),
  del: vi.fn(async (k: string) => {
    hashes.delete(k);
    sets.delete(k);
    strings.delete(k);
    return 1;
  }),
  expire: vi.fn(async (k: string, seconds: number) => {
    ttls.set(k, seconds);
    return 1;
  }),
  sadd: vi.fn(async (k: string, ...members: string[]) => {
    const s = sets.get(k) ?? new Set<string>();
    members.forEach((m) => s.add(m));
    sets.set(k, s);
    return members.length;
  }),
  sismember: vi.fn(async (k: string, m: string) => (sets.get(k)?.has(m) ? 1 : 0)),
  exists: vi.fn(async (k: string) => (hashes.has(k) || sets.has(k) || strings.has(k) ? 1 : 0)),
  set: vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
    const nx = _rest.includes("NX");
    if (nx && strings.has(k)) return null;
    strings.set(k, v);
    return "OK";
  }),
  multi() {
    const ops: (() => Promise<unknown>)[] = [];
    const chain = {
      del: (k: string) => (ops.push(() => fake.del(k)), chain),
      hset: (k: string, ...a: string[]) => (ops.push(() => fake.hset(k, ...a)), chain),
      expire: (k: string, s: number) => (ops.push(() => fake.expire(k, s)), chain),
      sadd: (k: string, ...m: string[]) => (ops.push(() => fake.sadd(k, ...m)), chain),
      set: (k: string, v: string, ...r: unknown[]) => (ops.push(() => fake.set(k, v, ...r)), chain),
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  },
};

vi.mock("@/lib/redis", () => ({ default: fake }));
vi.mock("server-only", () => ({}));

const listSevenShiftsUsers = vi.fn();
const isSevenShiftsConfigured = vi.fn(() => true);
vi.mock("~/lib/api/sevenshifts", () => ({
  listSevenShiftsUsers: (...a: unknown[]) => listSevenShiftsUsers(...a),
  isSevenShiftsConfigured: () => isSevenShiftsConfigured(),
}));

function roster(...users: { id: number; punch_id: string; first_name: string }[]) {
  return { items: users.map((u) => ({ last_name: "Staff", ...u })), truncated: false };
}

async function load() {
  return await import("./service");
}

/** The freshness marker lapsing — what REFRESH_SECONDS does in production. */
function goStale() {
  strings.delete("staff:punch-index:fresh");
}

/** The rebuild lock lapsing — what REBUILD_LOCK_SECONDS does in production. */
function releaseLock() {
  strings.delete("staff:punch-index:lock");
}

beforeEach(() => {
  hashes.clear();
  sets.clear();
  strings.clear();
  ttls.clear();
  vi.clearAllMocks();
  isSevenShiftsConfigured.mockReturnValue(true);
  vi.resetModules();
});

describe("verifyPunchId", () => {
  it("resolves a cold index by paging 7shifts once, then answers from cache", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 77, punch_id: "1234", first_name: "Ada" }));
    const { verifyPunchId } = await load();

    const first = await verifyPunchId("1234");
    expect(first).toEqual({
      ok: true,
      staff: { userId: 77, punchId: "1234", firstName: "Ada", lastName: "Staff" },
      stale: false,
    });
    expect(listSevenShiftsUsers).toHaveBeenCalledTimes(1);

    // Second press: pure cache. This is the ~100% path and must not call out.
    const second = await verifyPunchId("1234");
    expect(second.ok).toBe(true);
    expect(listSevenShiftsUsers).toHaveBeenCalledTimes(1);
  });

  it("trims what the keypad sends", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "42", first_name: "Ada" }));
    const { verifyPunchId } = await load();
    expect((await verifyPunchId(" 42 ")).ok).toBe(true);
  });

  it("calls a miss against a FRESH index unknown without touching 7shifts", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    const { verifyPunchId } = await load();
    await verifyPunchId("1234"); // builds + marks fresh
    listSevenShiftsUsers.mockClear();

    expect(await verifyPunchId("9999")).toEqual({ ok: false, reason: "unknown" });
    expect(listSevenShiftsUsers).not.toHaveBeenCalled();
  });

  it("rebuilds on a miss against a STALE index so a new hire can sign in", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    const { verifyPunchId } = await load();
    await verifyPunchId("1234");

    // Freshness marker expires; the hash itself lives much longer.
    goStale();
    releaseLock();
    listSevenShiftsUsers.mockResolvedValue(
      roster(
        { id: 1, punch_id: "1234", first_name: "Ada" },
        { id: 2, punch_id: "555", first_name: "Grace" },
      ),
    );

    const res = await verifyPunchId("555");
    expect(res).toMatchObject({ ok: true, staff: { userId: 2, firstName: "Grace" } });
  });

  it("does not stampede 7shifts when someone mistypes repeatedly", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    const { verifyPunchId } = await load();
    await verifyPunchId("1234");
    listSevenShiftsUsers.mockClear();

    // Stale index + four wrong entries inside one lock window: exactly one
    // rebuild. The lock is released once first, standing in for the cold
    // build's own lock having lapsed.
    releaseLock();
    for (const wrong of ["1", "12", "123", "9999"]) {
      goStale();
      await verifyPunchId(wrong);
    }
    expect(listSevenShiftsUsers).toHaveBeenCalledTimes(1);
  });

  it("refuses a punch id two active employees share", async () => {
    listSevenShiftsUsers.mockResolvedValue(
      roster(
        { id: 1, punch_id: "55", first_name: "Ada" },
        { id: 2, punch_id: "55", first_name: "Grace" },
      ),
    );
    const { verifyPunchId } = await load();
    expect(await verifyPunchId("55")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("reports unavailable — not unknown — when 7shifts is down on a cold cache", async () => {
    // The difference matters: the caller can degrade to the heat-number prompt
    // instead of telling a correct staff member their id is wrong.
    listSevenShiftsUsers.mockRejectedValue(new Error("cloudflare"));
    const { verifyPunchId } = await load();
    expect(await verifyPunchId("1234")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("keeps serving a stale index while 7shifts is unreachable", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    const { verifyPunchId } = await load();
    await verifyPunchId("1234");

    strings.delete("staff:punch-index:fresh");
    listSevenShiftsUsers.mockRejectedValue(new Error("cloudflare"));

    const res = await verifyPunchId("1234");
    expect(res).toMatchObject({ ok: true, stale: true });
  });
});

describe("rebuildPunchIndex", () => {
  it("replaces rather than merges, so a departed employee stops being able to sign", async () => {
    listSevenShiftsUsers.mockResolvedValue(
      roster(
        { id: 1, punch_id: "1234", first_name: "Ada" },
        { id: 2, punch_id: "555", first_name: "Grace" },
      ),
    );
    const { rebuildPunchIndex, verifyPunchId } = await load();
    await rebuildPunchIndex();
    expect((await verifyPunchId("555")).ok).toBe(true);

    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    await rebuildPunchIndex();
    expect(await verifyPunchId("555")).toEqual({ ok: false, reason: "unknown" });
  });

  it("gives the index a far longer life than its freshness marker", async () => {
    // This gap IS the fail-open window: 7shifts being down must degrade to a
    // stale-but-complete index, never to a room that cannot start its video.
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    const { rebuildPunchIndex } = await load();
    await rebuildPunchIndex();
    expect(ttls.get("staff:punch-index")).toBeGreaterThan(60 * 60);
  });

  it("refuses to publish a truncated page run", async () => {
    listSevenShiftsUsers.mockResolvedValue({
      items: [{ id: 1, punch_id: "1234", first_name: "Ada", last_name: "S" }],
      truncated: true,
    });
    const { rebuildPunchIndex } = await load();
    expect(await rebuildPunchIndex()).toBeNull();
    expect(hashes.has("staff:punch-index")).toBe(false);
  });

  it("refuses to publish an empty roster over a working index", async () => {
    listSevenShiftsUsers.mockResolvedValue(roster({ id: 1, punch_id: "1234", first_name: "Ada" }));
    const { rebuildPunchIndex, verifyPunchId } = await load();
    await rebuildPunchIndex();

    listSevenShiftsUsers.mockResolvedValue({ items: [], truncated: false });
    expect(await rebuildPunchIndex()).toBeNull();
    expect((await verifyPunchId("1234")).ok).toBe(true);
  });

  it("returns null when no token is configured", async () => {
    isSevenShiftsConfigured.mockReturnValue(false);
    const { rebuildPunchIndex } = await load();
    expect(await rebuildPunchIndex()).toBeNull();
    expect(listSevenShiftsUsers).not.toHaveBeenCalled();
  });
});
