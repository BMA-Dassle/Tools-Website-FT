import { describe, expect, it } from "vitest";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import { REPS } from "../test-support";
import type { PruneInput, SevenShiftUpsert } from "../data/shifts-db";
import { rosterForDate, onShiftNow, type ShiftRow } from "./availability";
import {
  mirrorLocations,
  mirrorSevenShifts,
  repsBySevenShiftsUserId,
  shiftsToUpserts,
} from "./mirror";
import type { SevenShift, SevenShiftsUserRaw } from "./sevenshifts";

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
        return input.keep.length === 0 ? 2 : 0;
      },
    },
  };
}

/** A client that knows no department; the GS cases pass their own. */
const noUsers = {
  async listUsers(): Promise<SevenShiftsUserRaw[]> {
    return [];
  },
};

const user = (id: number, first: string, email: string): SevenShiftsUserRaw => ({
  id,
  first_name: first,
  last_name: "Agent",
  email,
});

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
      ...noUsers,
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
      keep: [{ repId: "1", shiftDate: "2026-09-12", sevenShiftsShiftId: "1" }],
    });
    expect(mem.prunes[1]).toEqual({
      locationId: 467486,
      dates: ["2026-09-12", "2026-09-13"],
      keep: [],
    });
    expect(summary.locations[0]).toEqual({
      locationId: 332160,
      centres: ["HPFM"],
      fetched: 2,
      matched: 1,
      gsRows: 0,
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
      ...noUsers,
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

/**
 * Guest Services = the 7shifts "Call Center" department (owner, 2026-09-13,
 * §5.7b). Two agents on overlapping shifts must fold into ONE bucket window,
 * and nobody's sign-in row may be invented from the department.
 */
describe("mirrorSevenShifts · Guest Services department coverage", () => {
  const GS_REP_ID = "4";
  const AGENTS = [
    user(901, "Jasmine", "jasmine@headpinz.com"),
    user(902, "Paula", "paula@headpinz.com"),
  ];

  const gsClient = (shifts: SevenShift[], seen?: number[]) => ({
    async listShifts(input: { locationId: number }) {
      return input.locationId === 332160 ? shifts : [];
    },
    async listUsers(input: { departmentId?: number }) {
      if (input.departmentId !== undefined) seen?.push(input.departmentId);
      return input.departmentId === 635186 ? AGENTS : [];
    },
  });

  it("two department members on overlapping shifts become two bucket rows that fold into one gs window", async () => {
    const seen: number[] = [];
    const mem = memoryStore();
    const summary = await mirrorSevenShifts({
      client: gsClient(
        [
          shift({
            id: "70",
            userId: 901,
            start: "2026-09-12T09:00:00-04:00",
            end: "2026-09-12T17:00:00-04:00",
          }),
          shift({
            id: "71",
            userId: 902,
            start: "2026-09-12T15:00:00-04:00",
            end: "2026-09-12T22:00:00-04:00",
          }),
        ],
        seen,
      ),
      store: mem.store,
      reps,
      centres: CENTRE_LIST,
      todayYmd: "2026-09-12",
      tomorrowYmd: "2026-09-13",
      gsRepId: GS_REP_ID,
      gsDepartmentIds: [635186],
    });

    expect(seen).toEqual([635186]);
    expect(summary.gs).toEqual({
      repId: GS_REP_ID,
      departments: [{ departmentId: 635186, users: 2 }],
      userIds: [901, 902],
    });
    // Both shifts are the bucket's, and neither agent is reported as an
    // unmatched user needing a rep row.
    expect(mem.upserts[0]).toEqual([
      expect.objectContaining({ repId: GS_REP_ID, sevenShiftsShiftId: "70" }),
      expect.objectContaining({ repId: GS_REP_ID, sevenShiftsShiftId: "71" }),
    ]);
    expect(summary.locations[0]).toMatchObject({ gsRows: 2, unmatchedUserIds: [] });
    expect(summary.repsWithoutSevenShiftsId).not.toContain("gs");

    // 9–17 and 15–22 overlap → ONE window, and the bucket is on shift at 9 PM,
    // which is the whole point of the owner's decision.
    const rows: ShiftRow[] = mem.upserts[0].map((r, i) => ({
      id: String(i),
      repId: r.repId,
      shiftDate: r.shiftDate,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      source: "7shifts",
      sevenShiftsShiftId: r.sevenShiftsShiftId,
      locationId: r.locationId,
      offToday: false,
      offReason: null,
      updatedBy: null,
      syncedAt: null,
    }));
    const today = rosterForDate(rows, "2026-09-12");
    expect(today[GS_REP_ID]?.windows).toEqual([{ startHour: 9, endHour: 22 }]);
    expect(
      onShiftNow(GS_REP_ID, {
        shiftsToday: today,
        shiftsTomorrow: {},
        now: new Date("2026-09-12T21:00:00-04:00"),
      }),
    ).toBe(true);
  });

  it("a member who is ALSO a rep keeps their own row and gets a bucket row beside it", async () => {
    const mem = memoryStore();
    await mirrorSevenShifts({
      client: {
        async listShifts(input: { locationId: number }) {
          return input.locationId === 332160 ? [shift({ id: "80", userId: 6543210 })] : [];
        },
        async listUsers() {
          return [user(6543210, "Kelsea", "kelsea@headpinz.com")];
        },
      },
      store: mem.store,
      reps,
      centres: CENTRE_LIST,
      todayYmd: "2026-09-12",
      tomorrowYmd: "2026-09-13",
      gsRepId: GS_REP_ID,
      gsDepartmentIds: [635186],
    });
    expect(mem.upserts[0].map((r) => r.repId)).toEqual(["1", GS_REP_ID]);
    expect(mem.prunes[0].keep).toEqual([
      { repId: "1", shiftDate: "2026-09-12", sevenShiftsShiftId: "80" },
      { repId: GS_REP_ID, shiftDate: "2026-09-12", sevenShiftsShiftId: "80" },
    ]);
  });

  it("a department that 7shifts refuses is reported, and the bucket simply gets no coverage", async () => {
    const mem = memoryStore();
    const summary = await mirrorSevenShifts({
      client: {
        async listShifts() {
          return [];
        },
        async listUsers() {
          throw new Error("7shifts 403 on /users");
        },
      },
      store: mem.store,
      reps,
      centres: CENTRE_LIST,
      todayYmd: "2026-09-12",
      tomorrowYmd: "2026-09-13",
      gsRepId: GS_REP_ID,
      gsDepartmentIds: [635186],
    });
    expect(summary.gs.departments).toEqual([
      { departmentId: 635186, users: 0, error: "7shifts 403 on /users" },
    ]);
    expect(summary.gs.userIds).toEqual([]);
  });
});

/**
 * B2-2: a shift that MOVES between the two mirrored days keeps its 7shifts id,
 * so the keep list must carry the (rep, date, id) triple or the old day's row
 * survives and the rep reads as on shift on a day they are not working.
 */
describe("mirrorSevenShifts · a moved shift", () => {
  it("keeps the triple for the NEW date only, so the old date's row is pruned", async () => {
    const mem = memoryStore();
    await mirrorSevenShifts({
      client: {
        ...noUsers,
        async listShifts(input: { locationId: number }) {
          return input.locationId === 332160
            ? [
                shift({
                  id: "8801234501",
                  localDate: "2026-09-13",
                  start: "2026-09-13T10:00:00-04:00",
                  end: "2026-09-13T18:00:00-04:00",
                }),
              ]
            : [];
        },
      },
      store: mem.store,
      reps,
      centres: CENTRE_LIST,
      todayYmd: "2026-09-12",
      tomorrowYmd: "2026-09-13",
    });
    expect(mem.prunes[0]).toEqual({
      locationId: 332160,
      dates: ["2026-09-12", "2026-09-13"],
      keep: [{ repId: "1", shiftDate: "2026-09-13", sevenShiftsShiftId: "8801234501" }],
    });
    // Yesterday's mirrored row for the SAME id is not in the keep list, so the
    // DELETE removes it (`data/rules-db.test.ts` pins the statement itself).
    expect(mem.prunes[0].keep.some((k) => k.shiftDate === "2026-09-12")).toBe(false);
  });
});
