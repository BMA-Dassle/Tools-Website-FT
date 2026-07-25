import { describe, it, expect } from "vitest";
import {
  racersFromMetadata,
  assignableRacers,
  summarizeLink,
  racerKey,
  type AssignRacer,
} from "./race-session-assign";

/** A persisted booking_metadata.heats entry (checkout.ts raceHeatsMetadata shape). */
function heat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: null, // null → buildKioskRacersFromHeats skips the catalog lookup
    track: "Blue",
    heatId: "2026-07-25T19:00:00",
    assignedTo: "m1",
    tier: "starter",
    category: "adult",
    bmiPersonId: "56334433",
    racer: "Mariana",
    bmiLineId: null,
    ...overrides,
  };
}

describe("racersFromMetadata", () => {
  it("rebuilds one racer row per persisted heat", () => {
    const racers = racersFromMetadata({
      heats: [
        heat(),
        heat({
          bmiPersonId: "56335233",
          racer: "Simon",
          track: "Red",
          heatId: "2026-07-25T18:24:00",
          tier: "intermediate",
        }),
      ],
    });
    expect(racers).toHaveLength(2);
    expect(racers[0]).toMatchObject({
      racerName: "Mariana",
      personId: "56334433",
      track: "Blue",
      heatStart: "2026-07-25T19:00:00",
      tier: "starter",
      category: "adult",
    });
    // heatStop is derived +7 min (naive UTC round-trip).
    expect(racers[0].heatStop).toBe("2026-07-25T19:07:00");
    expect(racers[1]).toMatchObject({ personId: "56335233", track: "Red", tier: "intermediate" });
  });

  it("drops heats with no bmiPersonId (can't be placed by id)", () => {
    const racers = racersFromMetadata({
      heats: [heat(), heat({ bmiPersonId: null, racer: "Guest" })],
    });
    expect(racers).toHaveLength(1);
    expect(racers[0].racerName).toBe("Mariana");
  });

  it("returns [] for a row with no heats / no metadata", () => {
    expect(racersFromMetadata(undefined)).toEqual([]);
    expect(racersFromMetadata(null)).toEqual([]);
    expect(racersFromMetadata({})).toEqual([]);
    expect(racersFromMetadata({ heats: [] })).toEqual([]);
  });
});

describe("assignableRacers", () => {
  it("keeps only racers with both a personId and a heatStart", () => {
    const racers = racersFromMetadata({
      heats: [heat(), heat({ heatId: null, racer: "NoHeat" })],
    });
    // The no-heat row is already dropped by racersFromMetadata (heatId not a
    // string), so build an explicit mixed set:
    const mixed: AssignRacer[] = [
      { ...racers[0] },
      { ...racers[0], personId: null, racerName: "NoId" },
      { ...racers[0], heatStart: null, racerName: "NoStart" },
    ];
    const out = assignableRacers(mixed);
    expect(out).toHaveLength(1);
    expect(out[0].racerName).toBe("Mariana");
  });
});

describe("summarizeLink", () => {
  const assignable = racersFromMetadata({
    heats: [heat(), heat({ bmiPersonId: "56335233", racer: "Simon" })],
  });

  it("declares complete when per-racer results are all inserted/already_linked", () => {
    const data = {
      success: true,
      data: {
        results: [
          { personId: "56334433", heatStart: "2026-07-25T19:00:00", status: "inserted" },
          { personId: "56335233", heatStart: "2026-07-25T19:00:00", status: "already_linked" },
        ],
      },
    };
    const s = summarizeLink(assignable, true, data);
    expect(s).toEqual({ linked: 2, missing: [], complete: true });
  });

  it("reports the still-missing racer by name on a partial results response", () => {
    const data = {
      success: true,
      data: {
        results: [{ personId: "56334433", heatStart: "2026-07-25T19:00:00", status: "inserted" }],
      },
    };
    const s = summarizeLink(assignable, true, data);
    expect(s.linked).toBe(1);
    expect(s.complete).toBe(false);
    expect(s.missing).toEqual(["Simon"]);
  });

  it("trusts a count-only response only when it covers the whole batch", () => {
    expect(summarizeLink(assignable, true, { success: true, data: { inserted: 2 } })).toEqual({
      linked: 2,
      missing: [],
      complete: true,
    });
    const partial = summarizeLink(assignable, true, { success: true, data: { inserted: 1 } });
    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual(["Mariana", "Simon"]);
  });

  it("treats a non-OK / success:false response as nothing linked", () => {
    expect(summarizeLink(assignable, false, null).complete).toBe(false);
    expect(summarizeLink(assignable, false, null).missing).toEqual(["Mariana", "Simon"]);
    expect(summarizeLink(assignable, true, { success: false }).complete).toBe(false);
  });

  it("is vacuously complete with nothing assignable", () => {
    expect(summarizeLink([], true, null)).toEqual({ linked: 0, missing: [], complete: true });
  });
});

describe("racerKey", () => {
  it("keys on personId + heatStart", () => {
    expect(racerKey({ personId: "1", heatStart: "t" })).toBe("1|t");
  });
});
