import { describe, expect, it, afterEach } from "vitest";
import {
  allBlocksForCenter,
  blockById,
  blockForLane,
  blocksForCenter,
  maxConcurrentGames,
  maxLanesPerBooking,
  NFL_BLOCKS_BY_CENTER,
} from "./blocks";
import { nflCenterEnabled, nflEnabledCenters, nflIncludePreseason } from "./flags";

const FM = 9172;
const NAPLES = 3148;

describe("Fort Myers blocks", () => {
  it("sells exactly the two VIP blocks", () => {
    expect(blocksForCenter(FM).map((b) => b.id)).toEqual(["fm-vip-a", "fm-vip-b"]);
  });

  it("covers VIP lanes 5-12 with no gap and no overlap", () => {
    const lanes = blocksForCenter(FM).flatMap((b) => b.lanes);
    expect(lanes).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it("keeps the regular pairs modelled but NOT sellable", () => {
    const all = allBlocksForCenter(FM);
    const regular = all.filter((b) => b.kind === "regular");
    expect(regular.length).toBe(8);
    expect(regular.every((b) => b.enabled === false)).toBe(true);
    expect(regular.every((b) => b.lanes.length === 2)).toBe(true);
  });

  it("regular pairs cover lanes 13-28, leaving 1-4 to Old Time Lanes", () => {
    const lanes = allBlocksForCenter(FM)
      .filter((b) => b.kind === "regular")
      .flatMap((b) => b.lanes);
    expect(lanes[0]).toBe(13);
    expect(lanes[lanes.length - 1]).toBe(28);
    expect(lanes.length).toBe(16);
    expect(lanes.some((n) => n <= 4)).toBe(false);
  });

  it("no lane belongs to two blocks", () => {
    const lanes = allBlocksForCenter(FM).flatMap((b) => b.lanes);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it("every block carries its center code, for joining to the catalog", () => {
    for (const b of allBlocksForCenter(FM)) {
      expect(b.centerId).toBe(FM);
      expect(b.centerCode).toBe("TXBSQN0FEKQ11");
    }
  });
});

describe("two blocks means two games", () => {
  it("maxConcurrentGames falls out of the block count, not a separate setting", () => {
    expect(maxConcurrentGames(FM)).toBe(2);
  });

  it("one booking may take at most a single block", () => {
    // 4 VIP lanes x 6 bowlers = 24 people. A bigger group is a sales call, not
    // a self-serve booking that quietly consumes both blocks.
    expect(maxLanesPerBooking(FM)).toBe(4);
  });
});

describe("lane lookup", () => {
  it("maps a VIP lane to its block", () => {
    expect(blockForLane(FM, 5)?.id).toBe("fm-vip-a");
    expect(blockForLane(FM, 8)?.id).toBe("fm-vip-a");
    expect(blockForLane(FM, 9)?.id).toBe("fm-vip-b");
    expect(blockForLane(FM, 12)?.id).toBe("fm-vip-b");
  });

  it("maps a regular lane to its (disabled) pair", () => {
    expect(blockForLane(FM, 20)?.id).toBe("fm-reg-4");
  });

  it("returns null for an Old Time lane and for a lane that does not exist", () => {
    expect(blockForLane(FM, 1)).toBeNull();
    expect(blockForLane(FM, 99)).toBeNull();
  });

  it("blockById finds disabled blocks too — the ops board needs them", () => {
    expect(blockById("fm-reg-1")?.lanes).toEqual([13, 14]);
    expect(blockById("nope")).toBeNull();
  });
});

describe("centers we do NOT sell", () => {
  it("Naples has no block model, so it cannot be sold", () => {
    expect(NFL_BLOCKS_BY_CENTER[NAPLES]).toBeUndefined();
    expect(blocksForCenter(NAPLES)).toEqual([]);
    expect(maxConcurrentGames(NAPLES)).toBe(0);
    expect(maxLanesPerBooking(NAPLES)).toBe(0);
  });
});

describe("flags", () => {
  const VAR = "NEXT_PUBLIC_NFL_VIP_ENABLED";
  const PRE = "NFL_INCLUDE_PRESEASON";
  afterEach(() => {
    delete process.env[VAR];
    delete process.env[PRE];
  });

  it("is ON by default — a merged feature is on", () => {
    expect(nflCenterEnabled(FM)).toBe(true);
    expect(nflEnabledCenters()).toEqual([FM]);
  });

  it('dies only on the literal "false"', () => {
    process.env[VAR] = "false";
    expect(nflCenterEnabled(FM)).toBe(false);
    expect(nflEnabledCenters()).toEqual([]);
    process.env[VAR] = "true";
    expect(nflCenterEnabled(FM)).toBe(true);
    process.env[VAR] = "FALSE";
    expect(nflCenterEnabled(FM)).toBe(true);
  });

  it("fails CLOSED for an unknown or missing center", () => {
    expect(nflCenterEnabled(NAPLES)).toBe(false);
    expect(nflCenterEnabled(null)).toBe(false);
    expect(nflCenterEnabled(undefined)).toBe(false);
    expect(nflCenterEnabled(0)).toBe(false);
  });

  it("preseason is off unless explicitly asked for", () => {
    expect(nflIncludePreseason()).toBe(false);
    process.env[PRE] = "true";
    expect(nflIncludePreseason()).toBe(true);
  });
});
