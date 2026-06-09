import { describe, expect, it } from "vitest";
import {
  CROSS_TRACK_MIN_GAP_MIN,
  TRACK_ADJACENT_GAP_MIN,
  findHeatConflict,
  heatsConflict,
  violatesMinGapAfter,
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

  describe("same-track Blue (15-min cadence, 16-min threshold)", () => {
    it("blocks adjacent heat 15 min apart", () => {
      expect(heatsConflict(T(15, 30), "Blue", T(15, 15), "Blue")).toBe(true);
      expect(heatsConflict(T(15, 30), "Blue", T(15, 45), "Blue")).toBe(true);
    });

    it("allows the next-after-adjacent heat at 30 min apart", () => {
      expect(heatsConflict(T(15, 30), "Blue", T(16, 0), "Blue")).toBe(false);
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
    expect(TRACK_ADJACENT_GAP_MIN.blue).toBe(16);
    expect(TRACK_ADJACENT_GAP_MIN.mega).toBe(13);
  });

  it("exposes the cross-track buffer constant", () => {
    expect(CROSS_TRACK_MIN_GAP_MIN).toBe(30);
  });
});
