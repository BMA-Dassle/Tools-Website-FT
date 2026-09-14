import { describe, expect, it, vi } from "vitest";

/**
 * The grid's projection — lane occupancy and Office heat blocks into the rows
 * the board draws.
 *
 * Redis is stubbed because `grid.server` reaches the availability sub's
 * transports, which own the 60-second cache. Nothing here goes near a vendor:
 * every function under test is a pure reshaping of a payload, and the vendor
 * reads themselves are already covered by `crm/availability/service/*.test.ts`
 * against MSW.
 */
vi.mock("@/lib/redis", () => ({
  default: { get: () => Promise.resolve(null), set: () => Promise.resolve("OK") },
}));

const { centreCodeFor, heatSectionFromResources, laneSectionsFromOccupancy } =
  await import("./grid.server");

describe("centreCodeFor", () => {
  it("accepts the Square location code the board actually holds", () => {
    expect(centreCodeFor("TXBSQN0FEKQ11")).toBe("HPFM");
    expect(centreCodeFor("PPTR5G2N0QXF7")).toBe("HPN");
    expect(centreCodeFor("LAB52GY480CJF")).toBe("FT");
  });

  it("also accepts the centre SLUG race and attraction rows are stored under", () => {
    expect(centreCodeFor("fort-myers")).toBe("HPFM");
    expect(centreCodeFor("naples")).toBe("HPN");
    expect(centreCodeFor("fasttrax")).toBe("FT");
  });

  it("is null for anything else, so the route can refuse rather than guess", () => {
    expect(centreCodeFor("")).toBeNull();
    expect(centreCodeFor("nope")).toBeNull();
  });
});

describe("laneSectionsFromOccupancy", () => {
  it("lays HeadPinz FM out in its real sections, every lane present", () => {
    const sections = laneSectionsFromOccupancy("HPFM", []);
    expect(sections.map((s) => s.name)).toEqual(["Old Time Lanes", "VIP", "Regular"]);
    expect(sections[0].rows.map((r) => r.label)).toEqual(["1", "2", "3", "4"]);
    expect(sections[2].rows).toHaveLength(16);
    // A lane the vendor said nothing about is EMPTY, not missing.
    expect(sections[1].rows.every((r) => r.bars.length === 0)).toBe(true);
  });

  it("puts a booking's bar on its own lane, carrying the id that makes it clickable", () => {
    const sections = laneSectionsFromOccupancy("HPN", [
      {
        lane: 3,
        blocks: [
          { kind: "walkin", label: "Soto", start: 16 * 60, end: 17 * 60, reservationId: "QR-9" },
        ],
      },
    ]);
    const regular = sections.find((s) => s.name === "Regular")!;
    const lane3 = regular.rows.find((r) => r.label === "3")!;
    expect(lane3.bars).toHaveLength(1);
    expect(lane3.bars[0]).toMatchObject({ start: 960, end: 1020, reservationId: "QR-9" });
  });

  it("coalesces a running session's schedule and floor bars into one", () => {
    const sections = laneSectionsFromOccupancy("HPN", [
      {
        lane: 3,
        blocks: [
          { kind: "walkin", label: "Soto", start: 16 * 60, end: 17 * 60, reservationId: "QR-9" },
          {
            kind: "walkin",
            label: "running QR-9",
            start: 16 * 60 + 50,
            end: 17 * 60 + 15,
            reservationId: "QR-9",
          },
        ],
      },
    ]);
    const lane3 = sections.find((s) => s.name === "Regular")!.rows.find((r) => r.label === "3")!;
    expect(lane3.bars).toHaveLength(1);
    expect(lane3.bars[0]).toMatchObject({ start: 960, end: 1035, label: "Soto" });
  });
});

describe("heatSectionFromResources", () => {
  const blue = {
    resourceId: "r-blue",
    resourceName: "Blue Track",
    blocks: [
      { start: 1035, stop: 1047, bookedSpots: 6, description: "Starter Race" },
      { start: 1050, stop: 1062, bookedSpots: 0, description: "Starter Race" },
    ],
  };

  it("draws only the heats somebody is actually in", () => {
    const [section] = heatSectionFromResources("FastTrax", [blue]);
    const row = section.rows[0];
    expect(row.bars).toHaveLength(1);
    expect(row.bars[0]).toMatchObject({ start: 1035, end: 1047, kind: "heat", trackKey: "blue" });
  });

  it("drops a resource with nothing booked all day", () => {
    const empty = {
      resourceId: "r-mini",
      resourceName: "Mini Track",
      blocks: [{ start: 1035, stop: 1047, bookedSpots: 0, description: "Kids" }],
    };
    const [section] = heatSectionFromResources("FastTrax", [blue, empty]);
    expect(section.rows.map((r) => r.label)).toEqual(["Blue Track"]);
  });

  it("has no section at all when the whole centre is quiet", () => {
    expect(heatSectionFromResources("FastTrax", [])).toEqual([]);
  });

  it("leaves trackKey off a resource whose name names no track", () => {
    const duckpin = {
      resourceId: "r-duck",
      resourceName: "Duckpin",
      blocks: [{ start: 1200, stop: 1260, bookedSpots: 4, description: "Duckpin" }],
    };
    const [section] = heatSectionFromResources("FastTrax", [duckpin]);
    expect(section.rows[0].bars[0].trackKey).toBeUndefined();
  });
});
