import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * PHASE 1: the venue WebSocket now writes the real carry, so these tests guard the
 * two things that would put a wrong heat in front of staff:
 *
 *   1. it goes through `recordCalledRace` → `applyCalledRace`, the seam that owns
 *      re-call pinning, the desk's Clear tombstone and the out-of-order guard;
 *   2. it REFUSES to write rather than write something half-known — a blank race
 *      type would look like a bug on the glass and an invented scheduled start
 *      would corrupt the on-time numbers.
 *
 * The frames are verbatim from `kart:events:queue`.
 */

const store = new Map<string, string>();
const list = new Map<string, string[]>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return "OK";
  }),
  del: vi.fn(async (k: string) => {
    store.delete(k);
    return 1;
  }),
  lpush: vi.fn(async (k: string, v: string) => {
    const arr = list.get(k) ?? [];
    arr.unshift(v);
    list.set(k, arr);
    return arr.length;
  }),
  ltrim: vi.fn(async () => "OK"),
  expire: vi.fn(async () => 1),
  lrange: vi.fn(async (k: string) => list.get(k) ?? []),
};
vi.mock("@/lib/redis", () => ({ default: redisMock }));

/** The desk's Clear tombstone, stubbed so a suppression can be exercised. */
const clearedCall = { value: null as { sessionId?: string; clearedAtMs?: number } | null };
vi.mock("~/features/signage/briefing/called-override.server", () => ({
  readClearedCall: vi.fn(async () => clearedCall.value),
  forgetClearedCall: vi.fn(async () => void 0),
}));

const { observeVenueCalls } = await import("./venue-called.server");
const CARRY_KEY = "pandora:last-race:fasttrax:mega";

const ADVICE_MEGA_68 = {
  $type: "RaceAdvice",
  RaceId: 58571867,
  Name: "68 - Mega Starter",
  ResourceId: -1,
  ResourceName: "Mega Track",
  ScheduledStart: "2026-08-18T22:50:00",
  ScheduledEnd: "2026-08-18T22:58:00",
  Drivers: [{ $type: "BcDriver", DriverId: 59128987, Alias: "Eric Osborn" }],
};
const CALL_MEGA_68 = {
  $type: "SessionAboutToStartNotification",
  SessionId: 58571867,
  SessionName: "68 - Mega Starter",
  ResourceId: -1,
  NotificationMetaId: -5022,
  Id: 59127337,
  Date: "2026-08-18T22:48:04.55",
};
const SEEN = Date.parse("2026-08-19T02:48:05.000Z");
const carry = () => {
  const raw = store.get(CARRY_KEY);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  store.clear();
  list.clear();
  clearedCall.value = null;
  delete process.env.VENUE_CALLED_FAST_PATH;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the venue writes the carry", () => {
  it("writes a full CurrentRace once it knows what the heat is", async () => {
    await observeVenueCalls(ADVICE_MEGA_68, SEEN - 60_000);
    await observeVenueCalls(CALL_MEGA_68, SEEN);

    expect(carry()).toEqual({
      trackName: "Mega",
      raceType: "Starter",
      heatNumber: 68,
      scheduledStart: new Date(Date.parse("2026-08-18T22:50:00-04:00")).toISOString(),
      calledAt: new Date(Date.parse("2026-08-18T22:48:04.550-04:00")).toISOString(),
      sessionId: 58571867,
    });
  });

  it("REFUSES to write when no RaceAdvice has told us what the heat is", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    expect(carry()).toBeNull();
  });

  it("REFUSES on a name with no race type — an unconfigured heat", async () => {
    // "Heat 69" carries no type; a blank raceType on a board reads as a bug.
    await observeVenueCalls({ ...ADVICE_MEGA_68, Name: "Heat 69" }, SEEN - 60_000);
    await observeVenueCalls({ ...CALL_MEGA_68, SessionName: "Heat 69" }, SEEN);
    expect(carry()).toBeNull();
  });

  it("writes nothing when the kill switch is off", async () => {
    process.env.VENUE_CALLED_FAST_PATH = "false";
    await observeVenueCalls(ADVICE_MEGA_68, SEEN - 60_000);
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    expect(carry()).toBeNull();
  });

  it("still records its own shadow key even when it declines the carry", async () => {
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    expect(store.get("venue:called:mega")).toBeTruthy();
    expect(carry()).toBeNull();
  });

  it("a re-announcement does NOT rewrite the carry (first call is the call)", async () => {
    await observeVenueCalls(ADVICE_MEGA_68, SEEN - 60_000);
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    const first = carry();

    await observeVenueCalls({ ...CALL_MEGA_68, Date: "2026-08-18T22:52:31.000" }, SEEN + 267_000);

    expect(carry()).toEqual(first);
    expect(carry().calledAt).toBe(
      new Date(Date.parse("2026-08-18T22:48:04.550-04:00")).toISOString(),
    );
  });

  it("honours the desk's Clear — a cleared heat is swallowed, not written", async () => {
    clearedCall.value = {
      sessionId: "58571867",
      clearedAtMs: Date.parse("2026-08-18T22:49:00-04:00"),
    };
    await observeVenueCalls(ADVICE_MEGA_68, SEEN - 60_000);
    await observeVenueCalls(CALL_MEGA_68, SEEN);

    expect(carry()).toBeNull();
  });

  it("does not resurrect a heat that already finished", async () => {
    await observeVenueCalls(ADVICE_MEGA_68, SEEN - 60_000);
    await observeVenueCalls(CALL_MEGA_68, SEEN);
    await observeVenueCalls(
      {
        $type: "SessionFinishedNotification",
        ResourceId: -1,
        SessionId: 58571867,
        SessionName: "68 - Mega Starter",
        Date: "2026-08-18T23:08:20.11",
      },
      SEEN + 1_215_000,
    );
    store.delete(CARRY_KEY); // the carry aged out; a late nag must not refill it

    await observeVenueCalls({ ...CALL_MEGA_68, Date: "2026-08-18T23:10:00.000" }, SEEN + 1_320_000);

    expect(carry()).toBeNull();
  });

  it("keeps tracks apart — a Blue call cannot touch Mega's carry", async () => {
    await observeVenueCalls(
      {
        ...ADVICE_MEGA_68,
        RaceId: 58599025,
        Name: "60 - Blue Starter",
        ResourceId: 11208654,
        ResourceName: "Blue Track",
      },
      SEEN - 60_000,
    );
    await observeVenueCalls(
      {
        ...CALL_MEGA_68,
        SessionId: 58599025,
        SessionName: "60 - Blue Starter",
        ResourceId: 11208654,
      },
      SEEN,
    );

    expect(carry()).toBeNull();
    expect(JSON.parse(store.get("pandora:last-race:fasttrax:blue")!).trackName).toBe("Blue");
  });
});

describe("parseRaceType", () => {
  it("splits the way Pandora splits it", async () => {
    const { parseRaceType } = await import("./venue-called.server");
    expect(parseRaceType("68 - Mega Starter", "mega")).toBe("Starter");
    expect(parseRaceType("35 - Blue Junior Pro", "blue")).toBe("Junior Pro");
    expect(parseRaceType("41 - Mega GF Starter", "mega")).toBe("GF Starter");
    // No track word at all — a private-event heat keeps its whole label.
    expect(parseRaceType("34 - Adult Only", "mega")).toBe("Adult Only");
    // Nothing usable: refuse rather than render a blank.
    expect(parseRaceType("Heat 69", "mega")).toBe("");
    expect(parseRaceType("Mega Track 67", "mega")).toBe("");
  });
});
