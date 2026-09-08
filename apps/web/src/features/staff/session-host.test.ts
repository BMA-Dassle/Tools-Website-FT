import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FIRST PRESS WINS is the rule worth pinning here, because it is invisible: the
 * code that enforces it is one "NX" argument, and a refactor to a plain SET
 * would pass every other test in this repo while quietly handing each group to
 * whoever pressed a button last. The consequence lands on a wall — the pit board
 * naming a manager who reached over to press Play it again, instead of the
 * person actually walking the group to the karts.
 */

const strings = new Map<string, string>();

const fake = {
  get: vi.fn(async (k: string) => strings.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...rest: unknown[]) => {
    if (rest.includes("NX") && strings.has(k)) return null;
    strings.set(k, v);
    return "OK";
  }),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => strings.get(k) ?? null)),
  del: vi.fn(async (k: string) => (strings.delete(k) ? 1 : 0)),
};

vi.mock("@/lib/redis", () => ({ default: fake }));
vi.mock("server-only", () => ({}));

const ADA = { userId: 77, punchId: "1234", firstName: "Ada", lastName: "Lovelace" };
const GRACE = { userId: 88, punchId: "555", firstName: "Grace", lastName: "Hopper" };

async function load() {
  return await import("./session-host");
}

beforeEach(() => {
  strings.clear();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("assignSessionHost", () => {
  it("claims a free session for the presser", async () => {
    const { assignSessionHost } = await load();
    const host = await assignSessionHost("60", ADA);
    expect(host).toMatchObject({ userId: 77, firstName: "Ada" });
    expect(host.assignedAt).toEqual(expect.any(String));
  });

  it("does NOT hand the group to a second presser", async () => {
    const { assignSessionHost, readSessionHost } = await load();
    await assignSessionHost("60", ADA);

    const second = await assignSessionHost("60", GRACE);
    expect(second).toMatchObject({ userId: 77, firstName: "Ada" });
    expect(await readSessionHost("60")).toMatchObject({ firstName: "Ada" });
  });

  it("keeps sessions independent", async () => {
    const { assignSessionHost, readSessionHost } = await load();
    await assignSessionHost("60", ADA);
    await assignSessionHost("61", GRACE);
    expect(await readSessionHost("60")).toMatchObject({ firstName: "Ada" });
    expect(await readSessionHost("61")).toMatchObject({ firstName: "Grace" });
  });

  it("survives Redis being down — a briefing is never refused over a name", async () => {
    fake.set.mockRejectedValueOnce(new Error("redis down"));
    const { assignSessionHost } = await load();
    await expect(assignSessionHost("60", ADA)).resolves.toMatchObject({ firstName: "Ada" });
  });

  it("is a no-op without a session id", async () => {
    const { assignSessionHost } = await load();
    await assignSessionHost("", ADA);
    expect(fake.set).not.toHaveBeenCalled();
  });
});

describe("readSessionHost", () => {
  it("returns null for an unclaimed session", async () => {
    const { readSessionHost } = await load();
    expect(await readSessionHost("60")).toBeNull();
    expect(await readSessionHost(null)).toBeNull();
  });

  it("returns null rather than throwing on unreadable data", async () => {
    const { readSessionHost } = await load();
    strings.set("staff:session-host:60", "{not json");
    expect(await readSessionHost("60")).toBeNull();
  });
});

describe("readSessionHosts", () => {
  it("reads many sessions in ONE round trip", async () => {
    const { assignSessionHost, readSessionHosts } = await load();
    await assignSessionHost("60", ADA);
    await assignSessionHost("61", GRACE);

    const hosts = await readSessionHosts(["60", "61", "62"]);
    expect(hosts["60"]).toMatchObject({ firstName: "Ada" });
    expect(hosts["61"]).toMatchObject({ firstName: "Grace" });
    expect(hosts["62"]).toBeUndefined();
    expect(fake.mget).toHaveBeenCalledTimes(1);
  });

  it("skips nulls and de-duplicates before asking Redis", async () => {
    const { readSessionHosts } = await load();
    await readSessionHosts(["60", null, "60", undefined]);
    expect(fake.mget).toHaveBeenCalledWith("staff:session-host:60");
  });

  it("makes no call at all when there is nothing to look up", async () => {
    const { readSessionHosts } = await load();
    expect(await readSessionHosts([null, undefined])).toEqual({});
    expect(fake.mget).not.toHaveBeenCalled();
  });

  it("loses only the unreadable row, not the whole board", async () => {
    const { assignSessionHost, readSessionHosts } = await load();
    await assignSessionHost("60", ADA);
    strings.set("staff:session-host:61", "{not json");

    const hosts = await readSessionHosts(["60", "61"]);
    expect(hosts["60"]).toMatchObject({ firstName: "Ada" });
    expect(hosts["61"]).toBeUndefined();
  });
});

/**
 * THE TWO WAYS OUT OF FIRST-PRESS-WINS, and both are here because the rule they
 * bend is the one above. `reassignSessionHost` is the hand-over a person
 * confirmed in a modal; `releaseSessionHost` is a mis-pull being undone. A
 * refactor that gave either of them an NX would restore the exact bug staff
 * reported — a group stuck with the last person's name for the night.
 */
describe("reassignSessionHost", () => {
  it("takes a group that somebody else already holds", async () => {
    const { assignSessionHost, reassignSessionHost, readSessionHost } = await load();
    await assignSessionHost("60", ADA);

    const host = await reassignSessionHost("60", GRACE);
    expect(host).toMatchObject({ userId: 88, firstName: "Grace" });
    expect(await readSessionHost("60")).toMatchObject({ userId: 88, firstName: "Grace" });
  });

  it("does NOT use NX — that is the whole difference from a claim", async () => {
    const { assignSessionHost, reassignSessionHost } = await load();
    await assignSessionHost("60", ADA);
    fake.set.mockClear();

    await reassignSessionHost("60", GRACE);
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(fake.set.mock.calls[0]).not.toContain("NX");
  });

  it("resets the 24h window for the new host", async () => {
    const { reassignSessionHost } = await load();
    await reassignSessionHost("60", GRACE);
    expect(fake.set).toHaveBeenCalledWith(
      "staff:session-host:60",
      expect.any(String),
      "EX",
      24 * 60 * 60,
    );
  });

  it("claims a free session just as well — a hand-over need not follow a claim", async () => {
    const { reassignSessionHost, readSessionHost } = await load();
    await reassignSessionHost("60", ADA);
    expect(await readSessionHost("60")).toMatchObject({ firstName: "Ada" });
  });

  it("leaves other sessions alone", async () => {
    const { assignSessionHost, reassignSessionHost, readSessionHost } = await load();
    await assignSessionHost("60", ADA);
    await assignSessionHost("61", ADA);

    await reassignSessionHost("60", GRACE);
    expect(await readSessionHost("61")).toMatchObject({ firstName: "Ada" });
  });

  it("survives Redis being down — a hand-over is never refused over a name", async () => {
    fake.set.mockRejectedValueOnce(new Error("redis down"));
    const { reassignSessionHost } = await load();
    await expect(reassignSessionHost("60", GRACE)).resolves.toMatchObject({ firstName: "Grace" });
  });

  it("is a no-op without a session id", async () => {
    const { reassignSessionHost } = await load();
    await reassignSessionHost("", GRACE);
    expect(fake.set).not.toHaveBeenCalled();
  });
});

describe("releaseSessionHost", () => {
  it("gives the group back — the next press claims a free key", async () => {
    const { assignSessionHost, releaseSessionHost, readSessionHost } = await load();
    await assignSessionHost("60", ADA);

    await releaseSessionHost("60");
    expect(await readSessionHost("60")).toBeNull();

    // And the point of the release: the NX claim works again.
    expect(await assignSessionHost("60", GRACE)).toMatchObject({ firstName: "Grace" });
  });

  it("leaves other sessions alone", async () => {
    const { assignSessionHost, releaseSessionHost, readSessionHost } = await load();
    await assignSessionHost("60", ADA);
    await assignSessionHost("61", GRACE);

    await releaseSessionHost("60");
    expect(await readSessionHost("61")).toMatchObject({ firstName: "Grace" });
  });

  it("is a no-op on an unheld session, and on no session at all", async () => {
    const { releaseSessionHost } = await load();
    await expect(releaseSessionHost("60")).resolves.toBeUndefined();
    await releaseSessionHost(null);
    await releaseSessionHost(undefined);
    expect(fake.del).toHaveBeenCalledTimes(1);
  });

  it("survives Redis being down", async () => {
    fake.del.mockRejectedValueOnce(new Error("redis down"));
    const { releaseSessionHost } = await load();
    await expect(releaseSessionHost("60")).resolves.toBeUndefined();
  });
});
