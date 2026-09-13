import { describe, expect, it } from "vitest";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import { REPS } from "../test-support";
import type { PruneInput, SevenShiftUpsert } from "../data/shifts-db";
import {
  mirrorLocations,
  mirrorSevenShifts,
  repsBySevenShiftsUserId,
  shiftsToUpserts,
} from "./mirror";
import type { SevenShift } from "./sevenshifts";

/** The mirror with a fake client and an in-memory store: what is written, what is pruned, what is left alone. */

const reps = REPS.map((r) =>
  r.slug === "kelsea"
    ? { ...r, sevenShiftsUserId: 6543210 }
    : r.slug === "lori"
      ? { ...r, sevenShiftsUserId: 6543211 }
      : r,
);

const shift = (over: Partial<SevenShift>): SevenShift => ({
  id: "1",
  userId: 6543210,
  locationId: 332160,
  start: "2026-09-12T10:00:00-04:00",
  end: "2026-09-12T18:00:00-04:00",
  localDate: "2026-09-12",
  ...over,
});

function memoryStore() {
  const upserts: SevenShiftUpsert[][] = [];
  const prunes: PruneInput[] = [];
  return {
    upserts,
    prunes,
    store: {
      async upsertSevenShifts(rows: readonly SevenShiftUpsert[]) {
        upserts.push([...rows]);
        return rows.length;
      },
      async pruneSevenShifts(input: PruneInput) {
        prunes.push(input);
        return input.keepShiftIds.length === 0 ? 2 : 0;
      },
    },
  };
}

describe("mirrorLocations / repsBySevenShiftsUserId", () => {
  it("three centres → three 7shifts locations, in centre order", () => {
    expect(mirrorLocations(CENTRE_LIST)).toEqual([
      { locationId: 332160, centres: ["HPFM"] },
      { locationId: 467486, centres: ["FT"] },
      { locationId: 332145, centres: ["HPN"] },
    ]);
  });
  it("only active reps with a 7shifts id are joinable", () => {
    const m = repsBySevenShiftsUserId(reps);
    expect([...m.keys()]).toEqual([6543210, 6543211]);
    expect(repsBySevenShiftsUserId(reps.map((r) => ({ ...r, active: false }))).size).toBe(0);
  });
});

describe("shiftsToUpserts", () => {
  it("matched shifts become rows; open shifts and unknown users are counted, not stored; other dates dropped", () => {
    const { rows, unmatched, open } = shiftsToUpserts(
      [
        shift({}),
        shift({ id: "2", userId: null }),
        shift({ id: "3", userId: 777 }),
        shift({
          id: "4",
          userId: 6543211,
          localDate: "2026-09-14",
          start: "2026-09-14T12:00:00-04:00",
        }),
        shift({
          id: "5",
          userId: 6543211,
          localDate: "2026-09-13",
          start: "2026-09-13T12:00:00-04:00",
          end: "2026-09-13T20:00:00-04:00",
        }),
      ],
      repsBySevenShiftsUserId(reps),
      ["2026-09-12", "2026-09-13"],
    );
    expect(rows).toEqual([
      {
        repId: "1",
        shiftDate: "2026-09-12",
        startsAt: "2026-09-12T10:00:00-04:00",
        endsAt: "2026-09-12T18:00:00-04:00",
        sevenShiftsShiftId: "1",
        locationId: 332160,
      },
      {
        repId: "2",
        shiftDate: "2026-09-13",
        startsAt: "2026-09-13T12:00:00-04:00",
        endsAt: "2026-09-13T20:00:00-04:00",
        sevenShiftsShiftId: "5",
        locationId: 332160,
      },
    ]);
    expect(unmatched).toEqual([777]);
    expect(open).toBe(1);
  });
});

describe("mirrorSevenShifts", () => {
  it("asks each location for today+tomorrow, upserts the matches, prunes by the kept ids, never mentions manual rows", async () => {
    const asked: { locationId: number; fromYmd: string; toYmd: string }[] = [];
    const client = {
      async listShifts(input: { locationId: number; fromYmd: string; toYmd: string }) {
        asked.push(input);
        return input.locationId === 332160 ? [shift({}), shift({ id: "9", userId: null })] : [];
      },
    };
    const mem = memoryStore();
    const summary = await mirrorSevenShifts({
      client,
      store: mem.store,
      reps,
      centres: CENTRE_LIST,
      todayYmd: "2026-09-12",
      tomorrowYmd: "2026-09-13",
    });
    expect(asked).toEqual([
      { locationId: 332160, fromYmd: "2026-09-12", toYmd: "2026-09-13" },
      { locationId: 467486, fromYmd: "2026-09-12", toYmd: "2026-09-13" },
      { locationId: 332145, fromYmd: "2026-09-12", toYmd: "2026-09-13" },
    ]);
    expect(mem.upserts).toEqual([
      [expect.objectContaining({ sevenShiftsShiftId: "1", repId: "1" })],
      [],
      [],
    ]);
    expect(mem.prunes[0]).toEqual({
      locationId: 332160,
      dates: ["2026-09-12", "2026-09-13"],
      keepShiftIds: ["1"],
    });
    expect(mem.prunes[1]).toEqual({
      locationId: 467486,
      dates: ["2026-09-12", "2026-09-13"],
      keepShiftIds: [],
    });
    expect(summary.locations[0]).toEqual({
      locationId: 332160,
      centres: ["HPFM"],
      fetched: 2,
      matched: 1,
      upserted: 1,
      pruned: 0,
      unmatchedUserIds: [],
      openShifts: 1,
    });
    expect(summary.locations[1].pruned).toBe(2);
    expect(summary.dates).toEqual(["2026-09-12", "2026-09-13"]);
    expect(summary.repsWithoutSevenShiftsId).toEqual(["stephanie", "gs", "mkt"]);
  });

  it("one location failing is reported on that location and the others still run", async () => {
    const client = {
      async listShifts(input: { locationId: number }) {
        if (input.locationId === 467486) throw new Error("7shifts 503 on /shifts");
        return [shift({ locationId: input.locationId })];
      },
    };
    const mem = memoryStore();
    const summary = await mirrorSevenShifts({
      client,
      store: mem.store,
      reps,
      centres: CENTRE_LIST,
      todayYmd: "2026-09-12",
      tomorrowYmd: "2026-09-13",
    });
    expect(summary.locations.map((l) => l.error ?? null)).toEqual([
      null,
      "7shifts 503 on /shifts",
      null,
    ]);
    expect(mem.upserts).toHaveLength(2);
    expect(mem.prunes.map((p) => p.locationId)).toEqual([332160, 332145]);
  });
});
