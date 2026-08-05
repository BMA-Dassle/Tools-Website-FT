import { describe, expect, it } from "vitest";
import {
  CROSS_TRACK_MIN_GAP_MIN,
  TRACK_ADJACENT_GAP_MIN,
  collidesWithOtherCategory,
  crossCategoryCollisionMessage,
  findCrossBookingConflict,
  findCrossCategorySameStart,
  findHeatConflict,
  heatClockLabel,
  heatsConflict,
  packageGapMinutesFor,
  violatesMinGapAfter,
  type BookedPersonHeat,
} from "./conflict";

const T = (h: number, m = 0) =>
  new Date(`2026-06-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

describe("heatsConflict", () => {
  describe("same-track Red (12-min cadence, 13-min threshold)", () => {
    it("blocks adjacent heat 12 min apart", () => {
      expect(heatsConflict(T(15, 24), "Red", T(15, 12), "Red")).toBe(true); // 12 min < 13
      expect(heatsConflict(T(15, 24), "Red", T(15, 36), "Red")).toBe(true);
    });

    it("allows the next-after-adjacent heat at 24 min apart", () => {
      expect(heatsConflict(T(15, 24), "Red", T(15, 48), "Red")).toBe(false);
      expect(heatsConflict(T(15, 24), "Red", T(15, 0), "Red")).toBe(false);
    });

    it("is case-insensitive on track names", () => {
      expect(heatsConflict(T(15, 24), "RED", T(15, 12), "red")).toBe(true);
    });
  });

  describe("same-track Blue (12-min cadence since 2026-07-02, 13-min threshold)", () => {
    it("blocks adjacent heat 12 min apart", () => {
      expect(heatsConflict(T(15, 24), "Blue", T(15, 12), "Blue")).toBe(true);
      expect(heatsConflict(T(15, 24), "Blue", T(15, 36), "Blue")).toBe(true);
    });

    it("allows the next-after-adjacent heat at 24 min apart", () => {
      expect(heatsConflict(T(15, 24), "Blue", T(15, 48), "Blue")).toBe(false);
      expect(heatsConflict(T(15, 24), "Blue", T(15, 0), "Blue")).toBe(false);
    });
  });

  describe("same-track Mega (same cadence as Red)", () => {
    it("uses the 13-min threshold", () => {
      expect(heatsConflict(T(15, 0), "Mega", T(15, 12), "Mega")).toBe(true);
      expect(heatsConflict(T(15, 0), "Mega", T(15, 13), "Mega")).toBe(false);
    });
  });

  describe("cross-track Red ↔ Blue", () => {
    it("blocks anything within the 30-min walk buffer", () => {
      expect(heatsConflict(T(15, 0), "Red", T(15, 29), "Blue")).toBe(true);
      expect(heatsConflict(T(15, 0), "Red", T(14, 31), "Blue")).toBe(true);
    });

    it("allows ≥ 30-min separation", () => {
      expect(heatsConflict(T(15, 0), "Red", T(15, 30), "Blue")).toBe(false);
      expect(heatsConflict(T(15, 0), "Red", T(14, 30), "Blue")).toBe(false);
    });
  });

  describe("track label formats (BMI 'Red Track' vs picker 'Red')", () => {
    it("reads 'Red Track' and 'Red' as the SAME track — every-other heat (24 min) allowed", () => {
      expect(heatsConflict(T(15, 24), "Red Track", T(15, 48), "Red")).toBe(false);
      expect(heatsConflict(T(15, 24), "red-track", T(15, 48), "RED")).toBe(false);
    });

    it("still blocks the adjacent heat (12 min) across label formats", () => {
      expect(heatsConflict(T(15, 24), "Red Track", T(15, 36), "Red")).toBe(true);
      expect(heatsConflict(T(15, 24), "Blue Track", T(15, 12), "Blue")).toBe(true);
    });

    it("keeps the 30-min walk buffer for genuinely different tracks across formats", () => {
      expect(heatsConflict(T(15, 24), "Red Track", T(15, 48), "Blue")).toBe(true); // 24 min cross-track
      expect(heatsConflict(T(15, 0), "Mega Track", T(15, 30), "Red")).toBe(false); // 30 min — allowed
    });
  });

  describe("unknown / null tracks", () => {
    it("treats null vs null as cross-track (since `same` requires non-empty)", () => {
      // Both empty → falls through to cross-track 30-min rule
      expect(heatsConflict(T(15, 0), null, T(15, 29), null)).toBe(true);
      expect(heatsConflict(T(15, 0), null, T(15, 30), null)).toBe(false);
    });

    it("uses the cross-track threshold when one side is unknown", () => {
      expect(heatsConflict(T(15, 0), "Red", T(15, 29), null)).toBe(true);
      expect(heatsConflict(T(15, 0), null, T(15, 30), "Blue")).toBe(false);
    });
  });
});

describe("violatesMinGapAfter", () => {
  it("blocks a candidate that starts before prev-stop + gap", () => {
    expect(violatesMinGapAfter("2026-06-01T15:00:00Z", "2026-06-01T15:30:00Z", 60)).toBe(true);
  });

  it("allows a candidate that starts at exactly prev-stop + gap", () => {
    expect(violatesMinGapAfter("2026-06-01T15:00:00Z", "2026-06-01T16:00:00Z", 60)).toBe(false);
  });

  it("returns false on un-parseable inputs (don't block on bad data)", () => {
    expect(violatesMinGapAfter("nope", "2026-06-01T16:00:00Z", 60)).toBe(false);
    expect(violatesMinGapAfter("2026-06-01T15:00:00Z", "nope", 60)).toBe(false);
  });
});

describe("packageGapMinutesFor", () => {
  // The Ultimate Qualifier rule as configured in lib/packages.ts.
  const UQ = { minutes: 60, sameTrackMinutes: 30 };

  it("relaxes to sameTrackMinutes when the candidate stays on the ref's track", () => {
    expect(packageGapMinutesFor(UQ, "Red", "Red")).toBe(30);
    expect(packageGapMinutesFor(UQ, "Blue", "Blue")).toBe(30);
    expect(packageGapMinutesFor(UQ, "Mega", "Mega")).toBe(30);
  });

  it("keeps the full gap when the candidate switches tracks", () => {
    expect(packageGapMinutesFor(UQ, "Red", "Blue")).toBe(60);
    expect(packageGapMinutesFor(UQ, "Blue", "Red")).toBe(60);
  });

  it("normalizes the track like heatsConflict does ('Blue Track' ≡ 'Blue')", () => {
    expect(packageGapMinutesFor(UQ, "Blue Track", "Blue")).toBe(30);
    expect(packageGapMinutesFor(UQ, "blue", "BLUE TRACK")).toBe(30);
    expect(packageGapMinutesFor(UQ, "Red_Track", "red")).toBe(30);
  });

  it("treats an unknown/empty track on either side as a track CHANGE (stricter)", () => {
    expect(packageGapMinutesFor(UQ, null, null)).toBe(60);
    expect(packageGapMinutesFor(UQ, "", "")).toBe(60);
    expect(packageGapMinutesFor(UQ, "Red", null)).toBe(60);
    expect(packageGapMinutesFor(UQ, undefined, "Red")).toBe(60);
  });

  it("stays track-agnostic when the rule has no sameTrackMinutes", () => {
    expect(packageGapMinutesFor({ minutes: 60 }, "Red", "Red")).toBe(60);
    expect(packageGapMinutesFor({ minutes: 60 }, "Red", "Blue")).toBe(60);
  });

  it("honors a per-variant same-track number (Mega is 20, not 30)", () => {
    const MEGA = { minutes: 60, sameTrackMinutes: 20 };
    expect(packageGapMinutesFor(MEGA, "Mega", "Mega")).toBe(20);
    // The owner's worked example: a 10:10 Starter runs 7 min, so it stops at
    // 10:17 and the 10:40 Intermediate clears 20 but NOT the Red/Blue 30.
    expect(violatesMinGapAfter("2026-06-02T10:17:00", "2026-06-02T10:40:00", 20)).toBe(false);
    expect(violatesMinGapAfter("2026-06-02T10:17:00", "2026-06-02T10:40:00", 30)).toBe(true);
  });

  it("feeds violatesMinGapAfter — same-track 45 min apart passes, cross-track doesn't", () => {
    const starterStop = "2026-06-01T15:20:00";
    const candidate = "2026-06-01T16:05:00"; // 45 min after the Starter ends
    expect(
      violatesMinGapAfter(starterStop, candidate, packageGapMinutesFor(UQ, "Red", "Red")),
    ).toBe(false);
    expect(
      violatesMinGapAfter(starterStop, candidate, packageGapMinutesFor(UQ, "Red", "Blue")),
    ).toBe(true);
  });
});

describe("findHeatConflict", () => {
  it("finds the first pairwise conflict in a list", () => {
    const heats = [
      { start: T(15, 0), track: "Red" as const, label: "A" },
      { start: T(15, 12), track: "Red" as const, label: "B" }, // conflicts with A
      { start: T(15, 48), track: "Red" as const, label: "C" },
    ];
    const conflict = findHeatConflict(heats);
    expect(conflict).not.toBeNull();
    expect(conflict?.a.label).toBe("A");
    expect(conflict?.b.label).toBe("B");
  });

  it("returns null when no heats conflict", () => {
    const heats = [
      { start: T(15, 0), track: "Red" as const },
      { start: T(15, 48), track: "Red" as const },
      { start: T(16, 30), track: "Blue" as const },
    ];
    expect(findHeatConflict(heats)).toBeNull();
  });

  it("handles ISO string starts", () => {
    const heats = [
      { start: "2026-06-01T15:00:00Z", track: "Red" },
      { start: "2026-06-01T15:10:00Z", track: "Red" },
    ];
    expect(findHeatConflict(heats)).not.toBeNull();
  });
});

describe("thresholds export", () => {
  it("exposes per-track gap constants", () => {
    expect(TRACK_ADJACENT_GAP_MIN.red).toBe(13);
    expect(TRACK_ADJACENT_GAP_MIN.blue).toBe(13);
    expect(TRACK_ADJACENT_GAP_MIN.mega).toBe(13);
  });

  it("exposes the cross-track buffer constant", () => {
    expect(CROSS_TRACK_MIN_GAP_MIN).toBe(30);
  });
});

describe("findCrossBookingConflict (cross-reservation spacing)", () => {
  const h = (iso: string, track: string | null, pid: string | null): BookedPersonHeat => ({
    heatId: iso,
    track,
    bmiPersonId: pid,
  });

  it("blocks the same person booked adjacent (12 min) on the same track in another reservation", () => {
    const conflict = findCrossBookingConflict(
      [h("2026-07-02T15:36:00", "Red", "409523")],
      [h("2026-07-02T15:24:00", "Red", "409523")],
    );
    expect(conflict).not.toBeNull();
    expect(conflict?.existing.heatId).toBe("2026-07-02T15:24:00");
  });

  it("ignores a DIFFERENT person's heats in the same slots", () => {
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:36:00", "Red", "409523")],
        [h("2026-07-02T15:24:00", "Red", "777777")],
      ),
    ).toBeNull();
  });

  it("applies the 30-min cross-track walk buffer", () => {
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:36:00", "Blue", "409523")],
        [h("2026-07-02T15:12:00", "Red", "409523")], // 24 min apart, cross-track
      ),
    ).not.toBeNull();
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:42:00", "Blue", "409523")],
        [h("2026-07-02T15:12:00", "Red", "409523")], // 30 min — allowed
      ),
    ).toBeNull();
  });

  it("conflicts on the identical heat (double-booking the same slot across reservations)", () => {
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:24:00", "Red", "409523")],
        [h("2026-07-02T15:24:00", "Red", "409523")],
      ),
    ).not.toBeNull();
  });

  it("allows properly spaced heats for the same person", () => {
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:48:00", "Red", "409523")],
        [h("2026-07-02T15:24:00", "Red", "409523")], // 24 min same-track — fine
      ),
    ).toBeNull();
  });

  it("reads a BMI-format 'Blue Track' existing row as the same track as a 'Blue' cart pick", () => {
    // Every-other-heat (24 min) on the same physical track must stay bookable
    // even when the prior reservation stamped the BMI resource name.
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:48:00", "Blue", "409523")],
        [h("2026-07-02T15:24:00", "Blue Track", "409523")],
      ),
    ).toBeNull();
    // …while the adjacent heat (12 min) still conflicts across formats.
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:36:00", "Blue", "409523")],
        [h("2026-07-02T15:24:00", "Blue Track", "409523")],
      ),
    ).not.toBeNull();
  });

  it("skips heats without a bmiPersonId (unidentified racers)", () => {
    expect(
      findCrossBookingConflict(
        [h("2026-07-02T15:36:00", "Red", null)],
        [h("2026-07-02T15:24:00", "Red", null)],
      ),
    ).toBeNull();
  });
});

describe("heatClockLabel", () => {
  it("formats a naive heat start as 12-hour clock", () => {
    expect(heatClockLabel("2026-07-02T15:36:00")).toBe("3:36 PM");
    expect(heatClockLabel("2026-07-02T00:12:00")).toBe("12:12 AM");
    expect(heatClockLabel("2026-07-02T12:00:00")).toBe("12:00 PM");
    expect(heatClockLabel("2026-07-02T09:05:00")).toBe("9:05 AM");
  });
});

describe("findCrossCategorySameStart / collidesWithOtherCategory — adults vs juniors", () => {
  const ch = (
    heatId: string | null,
    track: string | null,
    category?: "adult" | "junior" | null,
  ) => ({ heatId, track, category });

  it("flags an adult and a junior sharing the same track + start", () => {
    const hit = findCrossCategorySameStart([
      ch("2026-07-19T15:00:00", "Blue", "adult"),
      ch("2026-07-19T15:00:00", "Blue", "junior"),
    ]);
    expect(hit).not.toBeNull();
    expect(hit!.start).toBe("2026-07-19T15:00:00");
    expect(hit!.track).toBe("Blue");
  });

  it("allows the same start on DIFFERENT tracks (owner rule — only the shared session is a double-book)", () => {
    expect(
      findCrossCategorySameStart([
        ch("2026-07-19T15:00:00", "Red", "adult"),
        ch("2026-07-19T15:00:00", "Blue", "junior"),
      ]),
    ).toBeNull();
  });

  it("allows the same category sharing one block (two adults in one heat)", () => {
    expect(
      findCrossCategorySameStart([
        ch("2026-07-19T15:00:00", "Blue", "adult"),
        ch("2026-07-19T15:00:00", "Blue", "adult"),
      ]),
    ).toBeNull();
  });

  it("allows adjacent (non-identical) starts across categories — spacing is not this rule's job", () => {
    expect(
      findCrossCategorySameStart([
        ch("2026-07-19T15:00:00", "Blue", "adult"),
        ch("2026-07-19T15:12:00", "Blue", "junior"),
      ]),
    ).toBeNull();
  });

  it("normalizes track naming and ISO variants ('Blue Track' ≡ 'blue', Z/millis stripped)", () => {
    expect(
      findCrossCategorySameStart([
        ch("2026-07-19T15:00:00Z", "Blue Track", "adult"),
        ch("2026-07-19T15:00:00.000", "blue", "junior"),
      ]),
    ).not.toBeNull();
  });

  it("defaults a missing category to adult (a legacy heat vs a junior heat still collides)", () => {
    expect(
      findCrossCategorySameStart([
        ch("2026-07-19T15:00:00", "Blue", null),
        ch("2026-07-19T15:00:00", "Blue", "junior"),
      ]),
    ).not.toBeNull();
  });

  it("is symmetric — order of the categories doesn't matter, and booked heats count", () => {
    expect(
      findCrossCategorySameStart([
        ch("2026-07-19T15:00:00", "Blue", "junior"),
        ch("2026-07-19T15:00:00", "Blue", "adult"),
      ]),
    ).not.toBeNull();
  });

  it("skips heats without a start", () => {
    expect(
      findCrossCategorySameStart([ch(null, "Blue", "adult"), ch(null, "Blue", "junior")]),
    ).toBeNull();
  });

  it("collidesWithOtherCategory greys exactly the shared (track, start) card", () => {
    const adultHeld = [{ heatId: "2026-07-19T15:00:00", track: "Blue" }];
    expect(collidesWithOtherCategory("Blue", "2026-07-19T15:00:00", adultHeld)).toBe(true);
    expect(collidesWithOtherCategory("Red", "2026-07-19T15:00:00", adultHeld)).toBe(false);
    expect(collidesWithOtherCategory("Blue", "2026-07-19T15:12:00", adultHeld)).toBe(false);
  });

  it("crossCategoryCollisionMessage names the time and track", () => {
    const msg = crossCategoryCollisionMessage("2026-07-19T15:00:00", "Blue");
    expect(msg).toContain("3:00 PM");
    expect(msg).toContain("Blue Track");
  });
});
