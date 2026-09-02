import { describe, expect, it } from "vitest";
import { blocksInUse, buildNflGameGroups, isNflReservation } from "./nfl-board";
import type { Reservation } from "./types";

const CHIEFS = {
  gameId: "g-chiefs",
  label: "Chiefs at Bills",
  kickoffIso: "2026-09-13T17:00:00.000Z", // 1:00 PM ET
  laneOpenEt: "2026-09-13T12:45:00-04:00",
};
const NIGHT = {
  gameId: "g-night",
  label: "Cowboys at Giants",
  kickoffIso: "2026-09-14T00:20:00.000Z", // 8:20 PM ET
  laneOpenEt: "2026-09-13T20:05:00-04:00",
};

function res(over: Partial<Reservation> & { id: number }): Reservation {
  return {
    guestName: `Guest ${over.id}`,
    playerCount: 6,
    status: "confirmed",
    insertedAt: `2026-09-01T10:0${over.id}:00.000Z`,
    lines: [],
    ...over,
  } as Reservation;
}

function nflRes(
  id: number,
  game: typeof CHIEFS,
  blockId: string,
  blockLabel: string,
  extra: Partial<Reservation> & { pin?: unknown; lane?: string } = {},
): Reservation {
  const { pin, lane, ...rest } = extra;
  return res({
    id,
    ...rest,
    dayofOrderLane: lane,
    bookingMetadata: {
      nfl: { ...game, blockId, blockLabel, claimId: id, ...(pin !== undefined ? { pin } : {}) },
    },
  } as Partial<Reservation> & { id: number });
}

describe("isNflReservation", () => {
  it("keys on the booking_metadata stamp, not a productKind", () => {
    // These ring up as ordinary VIP hourly bowling, so productKind cannot
    // distinguish them.
    expect(isNflReservation(nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)"))).toBe(true);
    expect(isNflReservation(res({ id: 2 }))).toBe(false);
    expect(isNflReservation(res({ id: 3, bookingMetadata: { heats: [] } }))).toBe(false);
    expect(isNflReservation(res({ id: 4, comboSpecialId: "race-bowl" }))).toBe(false);
  });
});

describe("buildNflGameGroups", () => {
  it("groups by game, then by block", () => {
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)", { lane: "5" }),
      nflRes(2, CHIEFS, "fm-vip-a", "VIP A (5-8)", { lane: "6" }),
      nflRes(3, NIGHT, "fm-vip-b", "VIP B (9-12)", { lane: "9" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Chiefs at Bills");
    expect(groups[0].blocks).toHaveLength(1);
    expect(groups[0].blocks[0].parties).toHaveLength(2);
    expect(groups[0].parties).toBe(2);
    expect(groups[0].players).toBe(12);
    expect(groups[1].label).toBe("Cowboys at Giants");
  });

  it("orders games by kickoff — the order the screens have to change", () => {
    const groups = buildNflGameGroups([
      nflRes(1, NIGHT, "fm-vip-b", "VIP B (9-12)"),
      nflRes(2, CHIEFS, "fm-vip-a", "VIP A (5-8)"),
    ]);
    expect(groups.map((g) => g.gameId)).toEqual(["g-chiefs", "g-night"]);
  });

  it("puts the party who claimed the block first", () => {
    const groups = buildNflGameGroups([
      nflRes(2, CHIEFS, "fm-vip-a", "VIP A (5-8)"),
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)"),
    ]);
    expect(groups[0].blocks[0].parties.map((p) => p.reservation.id)).toEqual([1, 2]);
  });

  it("collects the block's lanes, deduped and ascending", () => {
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)", { lane: "7,5" }),
      nflRes(2, CHIEFS, "fm-vip-a", "VIP A (5-8)", { lane: "5" }),
    ]);
    expect(groups[0].blocks[0].lanes).toEqual([5, 7]);
  });

  it("spreads one game across BOTH blocks when it spilled", () => {
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)"),
      nflRes(2, CHIEFS, "fm-vip-b", "VIP B (9-12)"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].blocks.map((b) => b.blockId)).toEqual(["fm-vip-a", "fm-vip-b"]);
  });

  it("drops cancelled parties — they hold no lane", () => {
    // Counting them would overstate how full a block is, and that number is
    // what staff use to decide whether the game can still be sold.
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)"),
      nflRes(2, CHIEFS, "fm-vip-a", "VIP A (5-8)", { status: "cancelled" }),
    ]);
    expect(groups[0].parties).toBe(1);
    expect(groups[0].players).toBe(6);
  });

  it("returns nothing for a day with no NFL bookings", () => {
    expect(buildNflGameGroups([res({ id: 1 })])).toEqual([]);
  });
});

describe("reseat flagging", () => {
  it("flags a party the pin FAILED on", () => {
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)", {
        pin: { pinned: false, lanes: [11], reason: "block-full", detail: "…" },
      }),
    ]);
    expect(groups[0].needsAttention).toBe(true);
    expect(groups[0].blocks[0].parties[0].needsReseat).toBe(true);
    expect(groups[0].blocks[0].parties[0].reseatReason).toBe("block-full");
  });

  it("does NOT flag a successful pin", () => {
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)", {
        pin: { pinned: true, lanes: [5], moved: true },
      }),
    ]);
    expect(groups[0].needsAttention).toBe(false);
  });

  it("does NOT flag a party with no pin recorded", () => {
    // QAMF may have seated them inside the block unaided — the common case on a
    // quiet day. Only an explicit failure asks for a human.
    const groups = buildNflGameGroups([nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)")]);
    expect(groups[0].needsAttention).toBe(false);
    expect(groups[0].blocks[0].parties[0].needsReseat).toBe(false);
  });
});

describe("blocksInUse", () => {
  it("counts distinct blocks committed across the day", () => {
    const groups = buildNflGameGroups([
      nflRes(1, CHIEFS, "fm-vip-a", "VIP A (5-8)"),
      nflRes(2, NIGHT, "fm-vip-a", "VIP A (5-8)"), // same block, later window
      nflRes(3, NIGHT, "fm-vip-b", "VIP B (9-12)"),
    ]);
    expect(blocksInUse(groups)).toBe(2);
  });
});
