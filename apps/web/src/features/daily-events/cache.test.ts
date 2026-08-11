import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The daily-events Redis read-through.
 *
 * These two tests exist because of a live incident (2026-08-11): the cache
 * lived in the daily-events ROUTES, not the service, so the lobby TV welcome
 * board — which calls the service directly — put ~24 live Office API calls a
 * minute through `office-api22` all day, six per screen poll, believing it was
 * riding the warm cache. The pair below pins the contract that fixed it:
 *
 *   1. `listDailyEvents` serves from Redis and NEVER touches the Office API.
 *   2. `listDailyEventsUncached` never READS Redis — it is the warmer's entry
 *      point, and a warmer that reads its own cache re-warms a stale copy
 *      forever, freezing the board on whatever it saw first.
 *
 * If test 1 breaks, the TV starts hammering BMI again. If test 2 breaks, the
 * board silently stops seeing new bookings. Neither failure is visible from
 * the outside, which is why they are pinned here rather than left to review.
 */

const redisGet = vi.fn();
const redisSetex = vi.fn(async () => "OK");
const officeGet = vi.fn();
const getLiveReservations = vi.fn(async () => []);
const getMetadataLookups = vi.fn(async () => ({
  resourceNames: {},
  productNames: {},
  payMethodNames: {},
  stateNames: {},
  kindNames: {},
  userNames: {},
}));

vi.mock("@/lib/redis", () => ({
  default: { get: redisGet, setex: redisSetex },
}));

vi.mock("./data/bmi-office", () => ({
  officeGet,
  officePut: vi.fn(),
  getMetadataLookups,
  getLiveReservations,
  getResourceIdsForLocation: vi.fn(async () => ["76810"]),
  fetchProjectRaw: vi.fn(),
  fetchPersonProfiles: vi.fn(async () => []),
  fetchPersonRaw: vi.fn(),
  OFFICE_ID_FIELDS: [],
  OfficeApiError: class extends Error {},
}));

/** HeadPinz Fort Myers — a shared-FM location, the expensive 3-call path. */
const LOCATION_ID = 332160;
const DATE = "2026-08-11";
const KEY = `de:res:${LOCATION_ID}:${DATE}:0`;

beforeEach(() => {
  vi.clearAllMocks();
  officeGet.mockResolvedValue({ projects: [], reservations: { projectSchedules: [] } });
});

describe("listDailyEvents — Redis read-through", () => {
  it("serves a warm cache WITHOUT calling the Office API", async () => {
    const cachedReservations = [{ id: "55762353000000001", when: "2026-08-11T14:00:00" }];
    redisGet.mockResolvedValue(
      JSON.stringify({ success: true, data: { reservations: cachedReservations } }),
    );

    const { listDailyEvents } = await import("./service");
    const result = await listDailyEvents(LOCATION_ID, DATE, false);

    expect(redisGet).toHaveBeenCalledWith(KEY);
    expect(result.reservations).toEqual(cachedReservations);
    // The whole point: a warm cache costs BMI nothing.
    expect(officeGet).not.toHaveBeenCalled();
    expect(getLiveReservations).not.toHaveBeenCalled();
  });

  it("preserves a 17-digit BMI id as a STRING across the Redis round-trip", async () => {
    // The classic off-by-one: this id exceeds MAX_SAFE_INTEGER, so any
    // Number()/parse round-trip names a different reservation or none at all.
    const rawId = "55762353123456789";
    redisGet.mockResolvedValue(
      JSON.stringify({ success: true, data: { reservations: [{ id: rawId }] } }),
    );

    const { listDailyEvents } = await import("./service");
    const result = await listDailyEvents(LOCATION_ID, DATE, false);

    expect(result.reservations[0].id).toBe(rawId);
    expect(typeof result.reservations[0].id).toBe("string");
  });

  it("falls through to a live fetch on a cache MISS, then writes the shared key", async () => {
    redisGet.mockResolvedValue(null);

    const { listDailyEvents } = await import("./service");
    await listDailyEvents(LOCATION_ID, DATE, false);

    expect(officeGet).toHaveBeenCalled();
    expect(redisSetex).toHaveBeenCalledWith(KEY, 360, expect.stringContaining('"success":true'));
  });

  it("falls through to a live fetch when Redis is DOWN (outage is non-fatal)", async () => {
    redisGet.mockRejectedValue(new Error("ECONNREFUSED"));

    const { listDailyEvents } = await import("./service");
    await expect(listDailyEvents(LOCATION_ID, DATE, false)).resolves.toBeDefined();
    expect(officeGet).toHaveBeenCalled();
  });
});

describe("listDailyEventsUncached — the warmer's entry point", () => {
  it("NEVER reads the cache, even when one is warm", async () => {
    // If this ever reads, the cron re-warms its own stale copy in perpetuity
    // and the board freezes on whatever it saw first.
    redisGet.mockResolvedValue(
      JSON.stringify({ success: true, data: { reservations: [{ id: "stale" }] } }),
    );

    const { listDailyEventsUncached } = await import("./service");
    await listDailyEventsUncached(LOCATION_ID, DATE, false);

    expect(redisGet).not.toHaveBeenCalled();
    expect(officeGet).toHaveBeenCalled();
  });
});
