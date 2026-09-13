import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMsw } from "../../../../../test/msw/server";
import { qamfHandlers } from "../../../../../test/msw/handlers/qamf";

/**
 * The QAMF transport end to end, against MSW — the read every verdict rests on.
 *
 * `onUnhandledRequest: "error"` is what keeps this honest: a change that made
 * this module call a real centre would fail here rather than reach production
 * (previews share production Neon and Redis, so "it only reads" is not a
 * defence).
 *
 * Redis is a recording stub. The 60-second cache is a real behaviour of this
 * module — one QAMF read per centre per date while a planner drags the start
 * time around — so it is asserted, not mocked away.
 */

const redisStore = new Map<string, string>();
/** Writes to `crm:avail:*` only — the QAMF token cache shares this client. */
const cacheWrites: string[] = [];

vi.mock("@/lib/redis", () => ({
  default: {
    get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
    set: (key: string, value: string) => {
      if (key.startsWith("crm:avail")) cacheWrites.push(key);
      redisStore.set(key, value);
      return Promise.resolve("OK");
    },
  },
}));

const server = installMsw(...qamfHandlers);

const {
  OUT_OF_SERVICE_LABEL,
  classifyKind,
  blockLabel,
  etDayBoundsMs,
  laneSectionsFor,
  occupancyMap,
  projectBusy,
  readLaneGrid,
} = await import("./qamf-grid");
const { evaluate, LANE_SECTIONS, sectionRuns } = await import("./engine");
const { http, rawJson } = await import("../../../../../test/msw/server");
const { QAMF_BASE, qamfFixtures } = await import("../../../../../test/msw/handlers/qamf");

/** The fixtures are a Fort Myers Saturday evening in EDT. */
const DATE = "2026-09-12";

/**
 * A FIXED clock, 8:30 PM on the fixture's own evening.
 *
 * `buildGrid` merges the schedule read with the live floor, and a floor
 * interval starts at NOW by construction — so without pinning the clock this
 * suite would assert one thing on the day and another thing the day after.
 * Only `Date` is faked; msw and undici keep their real timers.
 */
const NOW = new Date("2026-09-12T20:30:00-04:00");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  redisStore.clear();
  cacheWrites.length = 0;
  process.env.QAMF_BOWLING_CLIENT_ID = "BMA";
  process.env.QAMF_BOWLING_CLIENT_SECRET = "test-secret";
});

describe("classifyKind", () => {
  it("reads QAMF's free-text categories, however each centre spells them", () => {
    expect(classifyKind("League")).toBe("league");
    expect(classifyKind("Tuesday Night League")).toBe("league");
    expect(classifyKind("Maintenance")).toBe("maint");
    // Fort Myers writes "Non-bookable", Naples writes "Non - Bookable".
    expect(classifyKind("Non-bookable")).toBe("maint");
    expect(classifyKind("Non - Bookable")).toBe("maint");
    expect(classifyKind("Birthday Party")).toBe("party");
    expect(classifyKind("Group Event")).toBe("party");
    expect(classifyKind("Walk-in > Classic")).toBe("walkin");
    expect(classifyKind("")).toBe("walkin");
  });
});

describe("blockLabel", () => {
  it("prefers the reservation's own title, then its category", () => {
    expect(blockLabel("Patel birthday", "Birthday Party", "schedule")).toBe("Patel birthday");
    expect(blockLabel("", "League", "schedule")).toBe("League");
    expect(blockLabel("   ", "", "schedule")).toBe("Reservation");
    expect(blockLabel("", "", "floor")).toBe("On the lane now");
  });
});

describe("etDayBoundsMs", () => {
  it("is the centre's own midnight, on the day's real offset", () => {
    const summer = etDayBoundsMs("2026-09-12");
    expect(new Date(summer.startMs).toISOString()).toBe("2026-09-12T04:00:00.000Z");
    expect(summer.endMs - summer.startMs).toBe(24 * 60 * 60 * 1000);
    // …and EST in January, which is the half of the year a fixed offset breaks.
    const winter = etDayBoundsMs("2026-01-12");
    expect(new Date(winter.startMs).toISOString()).toBe("2026-01-12T05:00:00.000Z");
  });
});

describe("projectBusy", () => {
  const dayStartMs = etDayBoundsMs(DATE).startMs;

  it("puts every lane in the map, busy or not", () => {
    const rows = projectBusy([], [13, 14, 15], dayStartMs);
    expect(rows.map((r) => r.lane)).toEqual([13, 14, 15]);
    expect(rows.every((r) => r.blocks.length === 0)).toBe(true);
  });

  it("drops vendor noise — a lane row that ends before it starts", () => {
    const at = (h: number) => dayStartMs + h * 3_600_000;
    const rows = projectBusy(
      [
        {
          source: "schedule",
          laneNumber: 13,
          startMs: at(19),
          endMs: at(19),
          kind: "Walk-in",
          title: "",
        },
      ],
      [13],
      dayStartMs,
    );
    expect(rows[0].blocks).toEqual([]);
  });

  it("merges two touching stretches of the same booking into one bar", () => {
    const at = (h: number) => dayStartMs + h * 3_600_000;
    const rows = projectBusy(
      [
        {
          source: "schedule",
          laneNumber: 5,
          startMs: at(18),
          endMs: at(19),
          kind: "League",
          title: "Mixed",
        },
        {
          source: "schedule",
          laneNumber: 5,
          startMs: at(19),
          endMs: at(21),
          kind: "League",
          title: "Mixed",
        },
      ],
      [5],
      dayStartMs,
    );
    expect(rows[0].blocks).toEqual([
      { kind: "league", label: "Mixed", start: 18 * 60, end: 21 * 60 },
    ]);
  });
});

describe("laneSectionsFor", () => {
  it("knows which centres have a bowling grid at all", () => {
    expect(laneSectionsFor("HPFM")).toBe(LANE_SECTIONS.HPFM);
    expect(laneSectionsFor("HPN")).toBe(LANE_SECTIONS.HPN);
    // FastTrax is karting — it has no lanes, and pretending otherwise is how a
    // planner ends up promising a lane that does not exist.
    expect(laneSectionsFor("FT")).toBeNull();
  });
});

describe("readLaneGrid", () => {
  it("turns the vendor's reservations into lane blocks in centre-local minutes", async () => {
    const grid = await readLaneGrid("HPFM", DATE);
    expect(grid.cached).toBe(false);
    expect(grid.qamfCenterId).toBe(9172);
    expect(grid.lanes).toEqual([1, 5, 13, 14]);

    const map = occupancyMap(grid);
    // The web booking on the adjacent pair 13/14, 7-8 PM local.
    expect(map.get(13)).toEqual([
      { kind: "walkin", label: "Walk-in > Classic", start: 19 * 60, end: 20 * 60 },
    ]);
    expect(map.get(14)).toEqual(map.get(13));
    // The Conqueror league on lane 5, 6-9 PM — invisible to Neon, which is the
    // whole reason this screen reads QAMF instead of `bowling_reservations`.
    expect(map.get(5)?.[0]).toMatchObject({ kind: "league", start: 18 * 60, end: 21 * 60 });
  });

  it("keeps the live floor read, not only the schedule", async () => {
    // Lane 5 reports `Status: "Open"` — somebody is physically on it — and the
    // booking behind it ends at 9 PM. The grid must hold the lane to that end
    // plus turnaround (8:30 PM now → 9:15 PM), or a party booked half an hour
    // out gets handed a lane the current group is still using.
    const grid = await readLaneGrid("HPFM", DATE);
    const blocks = occupancyMap(grid).get(5) ?? [];
    const floor = blocks.find((b) => b.label.startsWith("running "));
    expect(floor).toMatchObject({ start: 20 * 60 + 30, end: 21 * 60 + 15 });
  });

  it("serves the second look from the 60-second cache, not from QAMF", async () => {
    const first = await readLaneGrid("HPFM", DATE);
    expect(cacheWrites).toEqual(["crm:avail:9172:2026-09-12"]);
    const second = await readLaneGrid("HPFM", DATE);
    expect(second.cached).toBe(true);
    expect(cacheWrites).toHaveLength(1);
    expect(second.occupancy).toEqual(first.occupancy);
  });

  it("goes back to the vendor when the planner asks for a refresh", async () => {
    await readLaneGrid("HPFM", DATE);
    const fresh = await readLaneGrid("HPFM", DATE, { refresh: true });
    expect(fresh.cached).toBe(false);
    expect(cacheWrites).toHaveLength(2);
  });

  it("refuses to answer for a centre with no lanes", async () => {
    await expect(readLaneGrid("FT", DATE)).rejects.toThrow(/no bowling grid/);
  });

  it("holds a lane QAMF reports in Error — it is under maintenance, not free", async () => {
    // Lane 15 is added to the floor read with `Status:"Error"` and NOTHING in
    // the schedule. `toFloorIntervals` only emits for `Status:"Open"`, so
    // before this the lane produced no block at all, `laneFreeIn` said true and
    // the verdict could offer a lane that physically cannot be opened.
    // `lane-plan`, which reads the same grid, has always treated Error as
    // never free.
    const lanes = JSON.parse(qamfFixtures.lanes()) as {
      Lanes: { LaneNumber: number; Status: string; Reservation: unknown }[];
    };
    lanes.Lanes.push({ LaneNumber: 15, Status: "Error", Reservation: null });
    server.use(
      http.get(`${QAMF_BASE}/centers/:centerId/lanes`, () => rawJson(JSON.stringify(lanes))),
    );

    const grid = await readLaneGrid("HPFM", DATE, { refresh: true });
    expect(grid.lanes).toContain(15);
    expect(occupancyMap(grid).get(15)).toEqual([
      { kind: "maint", label: OUT_OF_SERVICE_LABEL, start: 0, end: 24 * 60 },
    ]);

    const occupancy = occupancyMap(grid);
    const win = { start: 18 * 60, dur: 120 };
    const runs = sectionRuns(LANE_SECTIONS.HPFM, occupancy, win);
    const regular = runs.find((r) => r.section.name === "Regular");
    expect(regular?.runs.flat()).not.toContain(15);
    const verdict = evaluate({
      sections: LANE_SECTIONS.HPFM,
      occupancy,
      window: win,
      guests: 6,
      bounds: { openMin: 16 * 60, closeMin: 22 * 60 },
      knownLanes: new Set(grid.lanes),
    });
    expect(verdict.best?.lanes).not.toContain(15);
  });

  it("feeds the engine a verdict that respects the league nobody else can see", async () => {
    const grid = await readLaneGrid("HPFM", DATE);
    const occupancy = occupancyMap(grid);
    const bounds = { openMin: 16 * 60, closeMin: 22 * 60 };
    // Lane 5 is in the VIP section and is under a league 6-9 PM; a two-lane
    // party at 6 PM must not be placed on it.
    const verdict = evaluate({
      sections: LANE_SECTIONS.HPFM,
      occupancy,
      window: { start: 18 * 60, dur: 120 },
      guests: 12,
      bounds,
    });
    expect(verdict.need).toBe(2);
    expect(verdict.best?.lanes).not.toContain(5);
    const vip = verdict.sections.find((s) => s.section.name === "VIP");
    expect(vip?.runs.flat()).not.toContain(5);
  });
});
