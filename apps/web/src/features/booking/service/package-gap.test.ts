import { describe, expect, it } from "vitest";
import { getPackageIgnoreFlag, packageLoosestGapMinutes } from "@/lib/packages";

describe("packageLoosestGapMinutes", () => {
  it("returns the same-track relaxation, not the cross-track base", () => {
    expect(
      packageLoosestGapMinutes({
        minMinutesAfterEndOf: { ref: "s", minutes: 60, sameTrackMinutes: 30 },
      } as never),
    ).toBe(30);
    expect(
      packageLoosestGapMinutes({
        minMinutesAfterEndOf: { ref: "s", minutes: 60, sameTrackMinutes: 20 },
      } as never),
    ).toBe(20);
  });

  it("falls back to the base when the rule is track-agnostic, and 0 with no rule", () => {
    expect(
      packageLoosestGapMinutes({ minMinutesAfterEndOf: { ref: "s", minutes: 60 } } as never),
    ).toBe(60);
    expect(packageLoosestGapMinutes({} as never)).toBe(0);
  });

  // Pins the LIVE registry. Every Ultimate Qualifier variant relaxes to 30 on
  // the same track (Mega ran 20 for part of 2026-08-04, reverted same day), so
  // a variant silently losing its relaxation — and reverting to a 60-min gap —
  // fails here rather than in front of a guest.
  it("reports 30 for every live Ultimate Qualifier variant", () => {
    const gate = (id: string) => {
      const pkg = getPackageIgnoreFlag(id)!;
      return packageLoosestGapMinutes(pkg.races.find((r) => r.minMinutesAfterEndOf)!);
    };
    for (const id of [
      "ultimate-qualifier-mega",
      "ultimate-qualifier-weekday",
      "ultimate-qualifier-weekend",
      "ultimate-qualifier-weekday-junior",
      "ultimate-qualifier-weekend-junior",
    ]) {
      expect(gate(id), id).toBe(30);
    }
  });
});
