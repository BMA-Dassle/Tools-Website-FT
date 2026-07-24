/**
 * buildQualificationPatch: server refresh row → FIELD-SCOPED PartyMember patch.
 * The invariants under test are the money/safety ones: only returned fields
 * land in the patch (a failed source never wipes the snapshot), birthdate
 * derives dobIso/isMinor/category exactly like the people step, and protected
 * fields (bmiPersonId / isNewRacer / …) can never appear.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQualificationPatch } from "./qualification-refresh-client";

afterEach(() => vi.useRealTimers());

describe("buildQualificationPatch", () => {
  it("passes through only the fields the server returned", () => {
    const patch = buildQualificationPatch({
      id: "m1",
      memberships: ["Pro License"],
      waiverValid: true,
    });
    expect(patch).toEqual({ memberships: ["Pro License"], waiverValid: true });
    expect("creditBalances" in patch).toBe(false);
  });

  it("an all-sources-failed row yields an empty patch (snapshot survives)", () => {
    expect(buildQualificationPatch({ id: "m1" })).toEqual({});
  });

  it("keeps an explicit waiver DOWNGRADE (false is a real value, not absence)", () => {
    expect(buildQualificationPatch({ id: "m1", waiverValid: false })).toEqual({
      waiverValid: false,
    });
  });

  it("empty memberships is a real refresh result (expired license drops the tier)", () => {
    expect(buildQualificationPatch({ id: "m1", memberships: [] })).toEqual({ memberships: [] });
  });

  it("derives dobIso/isMinor/category from a BMI birthdate — 17yo is a minor adult-category racer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00"));
    // Hayden's case: 11/18/2008 → 17 → minor, racing category "adult" (13+).
    const patch = buildQualificationPatch({ id: "m1", birthdate: "2008-11-18T00:00:00" });
    expect(patch).toEqual({ dobIso: "2008-11-18", isMinor: true, category: "adult" });
  });

  it("derives junior category under 13", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00"));
    const patch = buildQualificationPatch({ id: "m1", birthdate: "2016-01-05" });
    expect(patch).toEqual({ dobIso: "2016-01-05", isMinor: true, category: "junior" });
  });

  it("ignores an unparseable birthdate", () => {
    expect(buildQualificationPatch({ id: "m1", birthdate: "not-a-date" })).toEqual({});
  });

  it("never emits protected fields", () => {
    const patch = buildQualificationPatch({
      id: "m1",
      memberships: ["Intermediate"],
      creditBalances: [{ kind: "Anytime Race Credit", balance: 2 }],
      waiverValid: true,
      birthdate: "1990-01-01",
    }) as Record<string, unknown>;
    for (const banned of ["bmiPersonId", "isNewRacer", "phoneVerified", "redeemCredits", "id"]) {
      expect(banned in patch).toBe(false);
    }
  });
});
