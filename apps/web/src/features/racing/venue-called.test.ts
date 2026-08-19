import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Frames below are VERBATIM from `kart:events:queue` (2026-08-18/19), not
 * hand-shaped fixtures — including the two ugly cases that would break a naive
 * implementation:
 *
 *   - Mega's `ResourceId` is the sentinel `-1`, not an id
 *   - the same heat arrived as "Heat 69" (no heat number parseable in the way a
 *     configured heat has) and as "69 - Mega Starter" 23 seconds later
 *
 * The shadow's contract is narrow and worth pinning exactly: never guess a
 * track, keep the FIRST stamp on a re-call, and never advance a heat we are not
 * holding — because each of those is what would put a wrong heat on every board
 * in the building once this writer is promoted.
 */

const store = new Map<string, string>();
const list = new Map<string, string[]>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return "OK";
  }),
  lpush: vi.fn(async (k: string, v: string) => {
    const arr = list.get(k) ?? [];
    arr.unshift(v);
    list.set(k, arr);
    return arr.length;
  }),
  ltrim: vi.fn(async () => "OK"),
  expire: vi.fn(async () => 1),
  lrange: vi.fn(async (k: string, start: number, stop: number) => {
    const arr = list.get(k) ?? [];
    return stop === -1 ? arr.slice(start) : arr.slice(start, stop + 1);
  }),
};
vi.mock("@/lib/redis", () => ({ default: redisMock }));

const { observeVenueCalls, readVenueCalledAll, readVenueCalledLog } =
  await import("./venue-called.server");
const { extractSessionCalls } = await import("./venue-broadcast");

/** Verbatim: Mega heat 68's call, 2026-08-18. */
const CALL_MEGA_68 = {
  $type: "SessionAboutToStartNotification",
  SessionId: 58571867,
  SessionName: "68 - Mega Starter",
  NotificationMetaId: -5022,
  ResourceId: -1,
  Id: 59127337,
  Date: "2026-08-18T22:48:04.55",
};
/** Verbatim shape for Blue — a real ResourceId rather than the sentinel. */
const CALL_BLUE_60 = {
  $type: "SessionAboutToStartNotification",
  SessionId: 58599025,
  SessionName: "60 - Blue Starter",
  NotificationMetaId: -5022,
  ResourceId: 11208654,
  Id: 58992427,
  Date: "2026-08-16T23:18:10.028",
};
const GREEN_MEGA_68 = {
  $type: "SessionStartedNotification",
  ResourceId: -1,
  SessionId: 58571867,
  SessionName: "68 - Mega Starter",
  NotificationMetaId: -5005,
  Id: 59128254,
  Date: "2026-08-18T23:00:53.708",
};
const FINISH_MEGA_68 = {
  $type: "SessionFinishedNotification",
  ResourceId: -1,
  SessionId: 58571867,
  SessionName: "68 - Mega Starter",
  NotificationMetaId: -5006,
  Id: 59128999,
  Date: "2026-08-18T23:08:20.11",
};

const SEEN = Date.parse("2026-08-19T02:48:05.000Z");

beforeEach(() => {
  store.clear();
  list.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("extractSessionCalls — the wire", () => {
  it("resolves Mega from the -1 sentinel, not from the name", () => {
    const [call] = extractSessionCalls(CALL_MEGA_68);
    expect(call.track).toBe("mega");
    expect(call.sessionId).toBe("58571867");
    expect(call.heatNumber).toBe(68);
    expect(call.atMs).toBe(Date.parse("2026-08-18T22:48:04.550-04:00"));
  });

  it("resolves Blue from its real ResourceId", () => {
    expect(extractSessionCalls(CALL_BLUE_60)[0].track).toBe("blue");
  });

  it("returns a null track rather than guessing, on an unknown resource", () => {
    const [call] = extractSessionCalls({ ...CALL_MEGA_68, ResourceId: 99999999 });
    expect(call.track).toBeNull();
    expect(call.sessionId).toBe("58571867"); // still parsed, just unplaceable
  });

  it("carries a null heat number for an unconfigured heat name", () => {
    // Seen live 2026-08-19: the same heat was "Heat 69" before it was "69 - Mega Starter".
    const [call] = extractSessionCalls({ ...CALL_MEGA_68, SessionName: "Heat 69" });
    expect(call.heatNumber).toBeNull();
    expect(call.track).toBe("mega");
  });

  it("keeps the session id as a STRING (house rule), never a number round-trip", () => {
    expect(typeof extractSessionCalls(CALL_MEGA_68)[0].sessionId).toBe("string");
  });

  it("ignores every other message type", () => {
    expect(extractSessionCalls(GREEN_MEGA_68)).toHaveLength(0);
    expect(extractSessionCalls({ $type: "BcTime", DateTime: "x" })).toHaveLength(0);
    expect(extractSessionCalls([CALL_MEGA_68, GREEN_MEGA_68])).toHaveLength(1);
  });
});

describe("observeVenueCalls — the shadow", () => {
  it("records a call under its own key, on the right track", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);

    const all = await readVenueCalledAll();
    expect(all.mega?.sessionId).toBe("58571867");
    expect(all.mega?.phase).toBe("called");
    expect(all.mega?.heatNumber).toBe(68);
    expect(all.mega?.seenAtMs).toBe(SEEN);
    expect(all.blue).toBeNull();
    expect(all.red).toBeNull();
  });

  it("writes NOTHING that a board reads — only venue:* keys", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    const written = redisMock.set.mock.calls.map((c) => String(c[0]));
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith("venue:")).toBe(true);
      expect(key).not.toContain("pandora:last-race");
    }
  });

  it("does not place a heat whose track it cannot resolve", async () => {
    await observeVenueCalls({ ...CALL_MEGA_68, ResourceId: 99999999 }, SEEN);
    expect(await readVenueCalledAll()).toEqual({ blue: null, red: null, mega: null });
  });

  it("keeps the FIRST stamp when the same heat is called again", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    const recall = { ...CALL_MEGA_68, Date: "2026-08-18T22:52:31.000" };
    await observeVenueCalls(recall, SEEN + 267_000);

    const all = await readVenueCalledAll();
    // preserveFirstCall's rule: a re-call must not reset the clock.
    expect(all.mega?.calledAtMs).toBe(Date.parse("2026-08-18T22:48:04.550-04:00"));
    expect(all.mega?.seenAtMs).toBe(SEEN);
    const calls = (await readVenueCalledLog()).filter((e) => e.event === "call");
    expect(calls).toHaveLength(2); // both logged, so the diff can count re-calls
  });

  it("does not count a DUPLICATE delivery as a second firing", async () => {
    // 1,714 of 1,716 venue records reach us twice, ~0.1s apart. The firing count
    // is the number the whole "is this the desk's call" question turns on, so an
    // identical (session, stamp) must not inflate it.
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    await observeVenueCalls(CALL_MEGA_68, SEEN + 120);

    expect((await readVenueCalledAll()).mega?.firings).toBe(1);
    expect((await readVenueCalledLog()).filter((e) => e.event === "call")).toHaveLength(1);
  });

  it("counts DISTINCT firings and keeps the FIRST as the call", async () => {
    // Mega 60, 2026-08-18: fired at 21:30:01, again 21:35:14, again 21:43:10. The
    // first is the call — our own record of 21:43:11 was the carry catching up
    // during a degraded evening, proved by heat 61 being recorded 20s after 60 on a
    // track whose heats run ten minutes apart. The later firings are the venue
    // re-announcing a heat still sitting on the grid, and must not move the stamp.
    await observeVenueCalls({ ...CALL_MEGA_68, Date: "2026-08-18T21:30:01.000" }, SEEN);
    await observeVenueCalls({ ...CALL_MEGA_68, Date: "2026-08-18T21:35:14.000" }, SEEN + 313_000);
    await observeVenueCalls({ ...CALL_MEGA_68, Date: "2026-08-18T21:43:10.000" }, SEEN + 789_000);

    const mega = (await readVenueCalledAll()).mega;
    expect(mega?.firings).toBe(3);
    expect(mega?.calledAtMs).toBe(Date.parse("2026-08-18T21:30:01.000-04:00"));
    expect(mega?.latestFiringMs).toBe(Date.parse("2026-08-18T21:43:10.000-04:00"));
  });

  it("replaces the held heat when a DIFFERENT heat is called on that track", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    const next = {
      ...CALL_MEGA_68,
      SessionId: 58571868,
      SessionName: "69 - Mega Pro",
      Date: "2026-08-18T22:58:00.000",
    };
    await observeVenueCalls(next, SEEN + 600_000);

    const all = await readVenueCalledAll();
    expect(all.mega?.sessionId).toBe("58571868");
    expect(all.mega?.calledAtMs).toBe(Date.parse("2026-08-18T22:58:00.000-04:00"));
  });

  it("advances to started on the green, keeping the call stamp", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    await observeVenueCalls(GREEN_MEGA_68, SEEN + 769_000);

    const all = await readVenueCalledAll();
    expect(all.mega?.phase).toBe("started");
    expect(all.mega?.startedAtMs).toBe(Date.parse("2026-08-18T23:00:53.708-04:00"));
    expect(all.mega?.calledAtMs).toBe(Date.parse("2026-08-18T22:48:04.550-04:00"));
  });

  it("marks finished but does NOT delete — the real carry holds a heat between races", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    await observeVenueCalls(GREEN_MEGA_68, SEEN + 769_000);
    await observeVenueCalls(FINISH_MEGA_68, SEEN + 1_215_000);

    const all = await readVenueCalledAll();
    expect(all.mega?.phase).toBe("finished");
    expect(all.mega?.finishedAtMs).toBe(Date.parse("2026-08-18T23:08:20.110-04:00"));
    expect(all.mega?.sessionId).toBe("58571867");
  });

  it("ignores a green for a heat it is not holding — never invents state", async () => {
    // The shadow missed this heat's call; a green must not conjure one, or the
    // coverage gap the shadow day exists to measure would be hidden.
    await observeVenueCalls(GREEN_MEGA_68, SEEN);
    expect((await readVenueCalledAll()).mega).toBeNull();
  });

  it("ignores a finish for a heat it is not holding", async () => {
    await observeVenueCalls(CALL_BLUE_60, SEEN);
    await observeVenueCalls(FINISH_MEGA_68, SEEN + 1000);
    const all = await readVenueCalledAll();
    expect(all.blue?.phase).toBe("called");
    expect(all.mega).toBeNull();
  });

  it("handles the catch-up ARRAY the bridge forwards after a reconnect", async () => {
    await observeVenueCalls([CALL_BLUE_60, CALL_MEGA_68, GREEN_MEGA_68], SEEN);
    const all = await readVenueCalledAll();
    expect(all.blue?.sessionId).toBe("58599025");
    expect(all.mega?.phase).toBe("started");
  });

  it("never throws, whatever arrives", async () => {
    await expect(observeVenueCalls(null, SEEN)).resolves.toBeUndefined();
    await expect(observeVenueCalls("nonsense", SEEN)).resolves.toBeUndefined();
    await expect(
      observeVenueCalls({ $type: "SessionAboutToStartNotification" }, SEEN),
    ).resolves.toBeUndefined();
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    await expect(observeVenueCalls(CALL_MEGA_68, SEEN)).resolves.toBeUndefined();
  });
});
