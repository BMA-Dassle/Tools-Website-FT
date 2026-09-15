import { describe, it, expect } from "vitest";
import {
  assembleItinerary,
  fmtTime12,
  fmtArriveBy,
  timeKey,
  toEtWallClock,
  type ItineraryInput,
} from "./itinerary";

const meta = (slug: string) =>
  slug === "gel-blaster" ? { name: "Gel Blaster", building: "HeadPinz Arena" } : null;

function base(overrides: Partial<ItineraryInput> = {}): ItineraryInput {
  return {
    racing: null,
    attractions: [],
    bowling: [],
    raceSims: [],
    meta,
    racingBuilding: "FastTrax Racing",
    bowlingBuilding: "HeadPinz Fort Myers",
    raceSimBuilding: "FastTrax Racing",
    ...overrides,
  };
}

describe("race sims on the itinerary", () => {
  it("titles a sim session with the CIRCUIT the guest bought", () => {
    // The whole point: a guest checking in is told "Bristol Motor Speedway",
    // not "Activity" and not "Track B".
    const { activities } = assembleItinerary(
      base({
        raceSims: [
          { startIso: "2026-09-16T19:15:00", circuit: "Bristol Motor Speedway", racerCount: 3 },
        ],
      }),
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]!.kind).toBe("racesim");
    expect(activities[0]!.title).toBe("Bristol Motor Speedway");
    expect(activities[0]!.timeLabel).toBe("7:15 PM");
    expect(activities[0]!.building).toBe("FastTrax Racing");
    expect(activities[0]!.totalCount).toBe(3);
  });

  it("falls back to the product name for a booking taken before circuits", () => {
    const { activities } = assembleItinerary(
      base({ raceSims: [{ startIso: "2026-08-30T19:15:00", circuit: null, racerCount: 2 }] }),
    );
    expect(activities[0]!.title).toBe("Race Sims");
  });

  it("sorts sim sessions into the plan with everything else", () => {
    const { activities, firstStop } = assembleItinerary(
      base({
        raceSims: [
          { startIso: "2026-09-16T19:15:00", circuit: "Bristol Motor Speedway", racerCount: 2 },
          { startIso: "2026-09-16T17:00:00", circuit: "Baku City Circuit", racerCount: 2 },
        ],
        attractions: [
          { slug: "gel-blaster", startIso: "2026-09-16T18:00:00", qtyPaid: 2, readyCount: 0 },
        ],
      }),
    );
    expect(activities.map((a) => a.title)).toEqual([
      "Baku City Circuit",
      "Gel Blaster",
      "Bristol Motor Speedway",
    ]);
    // A sim first stop shows its start time, not racing's 30-minute lead.
    expect(firstStop?.arriveByLabel).toBe("5:00 PM");
    expect(firstStop?.building).toBe("FastTrax Racing");
  });
});

describe("fmtTime12 (TZ-neutral wall-clock)", () => {
  it("formats a naive ET heat start without shifting", () => {
    expect(fmtTime12("2026-07-20T16:12:00")).toBe("4:12 PM");
  });
  it("formats an offset-carrying ET bowling bookedAt from its wall clock", () => {
    // The HH:mm in an ET-offset stamp IS the ET wall clock — no shift.
    expect(fmtTime12("2026-07-20T17:30:00-04:00")).toBe("5:30 PM");
  });
  it("handles midnight and noon", () => {
    expect(fmtTime12("2026-07-20T00:00:00")).toBe("12:00 AM");
    expect(fmtTime12("2026-07-20T12:00:00")).toBe("12:00 PM");
  });
});

describe("toEtWallClock (Neon TIMESTAMPTZ → ET wall-clock — the 4h-off guard)", () => {
  it("converts a UTC-Z instant to the ET wall clock (EDT: −4h)", () => {
    // 17:30Z in July is 1:30 PM ET — must NOT render as 5:30 PM.
    expect(fmtTime12(toEtWallClock("2026-07-20T17:30:00.000Z"))).toBe("1:30 PM");
  });
  it("passes a naive ET heat start through unchanged", () => {
    expect(toEtWallClock("2026-07-20T16:12:00")).toBe("2026-07-20T16:12:00");
  });
  it("passes an ET-offset stamp through (its wall clock is already ET)", () => {
    expect(fmtTime12(toEtWallClock("2026-07-20T17:30:00-04:00"))).toBe("5:30 PM");
  });
  it("returns empty for nullish", () => {
    expect(toEtWallClock(null)).toBe("");
    expect(toEtWallClock(undefined)).toBe("");
  });
});

describe("fmtArriveBy", () => {
  it("subtracts minutes across an hour boundary", () => {
    expect(fmtArriveBy("2026-07-20T16:12:00", 30)).toBe("3:42 PM");
  });
  it("crosses midnight backward correctly", () => {
    expect(fmtArriveBy("2026-07-20T00:10:00", 30)).toBe("11:40 PM");
  });
});

describe("timeKey", () => {
  it("strips Z and offset to a comparable minute", () => {
    expect(timeKey("2026-07-20T16:12:00")).toBe("2026-07-20T16:12");
    expect(timeKey("2026-07-20T16:12:00-04:00")).toBe("2026-07-20T16:12");
    expect(timeKey("2026-07-20T16:12:00Z")).toBe("2026-07-20T16:12");
  });
});

describe("assembleItinerary", () => {
  it("collapses racing to one activity and counts identified + valid-waiver racers as ready", () => {
    const { activities } = assembleItinerary(
      base({
        racing: {
          startIso: "2026-07-20T16:12:00",
          title: "Race · Blue Track",
          racers: [
            { name: "Eric O.", identified: true, waiverValid: true },
            { name: "Dana O.", identified: true, waiverValid: true },
            { name: "Guest 3", identified: false, waiverValid: false },
            { name: "Guest 4", identified: false, waiverValid: false },
          ],
        },
      }),
    );
    expect(activities).toHaveLength(1);
    expect(activities[0].kind).toBe("racing");
    expect(activities[0].readyCount).toBe(2);
    expect(activities[0].totalCount).toBe(4);
    expect(activities[0].timeLabel).toBe("4:12 PM");
  });

  it("an identified racer with an expired/missing waiver is NOT ready", () => {
    const { activities } = assembleItinerary(
      base({
        racing: {
          startIso: "2026-07-20T16:12:00",
          title: "Race · Blue Track",
          racers: [
            { name: "Eric O.", identified: true, waiverValid: true },
            { name: "Dana O.", identified: true, waiverValid: false },
          ],
        },
      }),
    );
    expect(activities[0].readyCount).toBe(1);
    expect(activities[0].totalCount).toBe(2);
  });

  it("sorts mixed activities by start (naive vs offset compared correctly) and sets first stop", () => {
    const { activities, firstStop } = assembleItinerary(
      base({
        racing: {
          startIso: "2026-07-20T16:12:00",
          title: "Race · Blue Track",
          racers: [{ name: "Eric", identified: true, waiverValid: true }],
        },
        attractions: [
          { slug: "gel-blaster", startIso: "2026-07-20T15:30:00", qtyPaid: 4, readyCount: 0 },
        ],
        bowling: [
          {
            kind: "bowling",
            startIso: "2026-07-20T17:30:00-04:00",
            playerCount: 4,
            laneLabel: "Lane 7",
            neonReservationId: 91,
          },
        ],
      }),
    );
    expect(activities.map((a) => a.kind)).toEqual(["attraction", "racing", "bowling"]);
    // First stop is the gel blaster (3:30) — an attraction, so arrive-by = start.
    expect(firstStop?.building).toBe("HeadPinz Arena");
    expect(firstStop?.arriveByLabel).toBe("3:30 PM");
  });

  it("shows a racing first stop's arrive-by as heat − 30 min", () => {
    const { firstStop } = assembleItinerary(
      base({
        racing: {
          startIso: "2026-07-20T16:12:00",
          title: "Race",
          racers: [{ name: "Eric", identified: true, waiverValid: true }],
        },
      }),
    );
    expect(firstStop?.arriveByLabel).toBe("3:42 PM");
  });

  it("labels bowling vs KBF and carries the neon id + lane", () => {
    const { activities } = assembleItinerary(
      base({
        bowling: [
          { kind: "kbf", startIso: "2026-07-20T14:00:00", playerCount: 3, neonReservationId: 5 },
        ],
      }),
    );
    expect(activities[0].title).toBe("Kids Bowl Free");
    expect(activities[0].neonReservationId).toBe(5);
  });

  it("returns null first stop for an empty itinerary", () => {
    const { activities, firstStop } = assembleItinerary(base());
    expect(activities).toHaveLength(0);
    expect(firstStop).toBeNull();
  });
});
