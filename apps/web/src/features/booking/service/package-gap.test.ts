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

  it("reports 20 for the live Mega variant and 30 for the Red/Blue variants", () => {
    const gate = (id: string) => {
      const pkg = getPackageIgnoreFlag(id)!;
      return packageLoosestGapMinutes(pkg.races.find((r) => r.minMinutesAfterEndOf)!);
    };
    expect(gate("ultimate-qualifier-mega")).toBe(20);
    expect(gate("ultimate-qualifier-weekday")).toBe(30);
    expect(gate("ultimate-qualifier-weekend")).toBe(30);
    expect(gate("ultimate-qualifier-weekday-junior")).toBe(30);
    expect(gate("ultimate-qualifier-weekend-junior")).toBe(30);
  });
});
