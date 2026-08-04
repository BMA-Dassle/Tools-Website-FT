import { describe, expect, it } from "vitest";
import { racerLicenseState, racerNeedsLicense, racersNeedingLicense } from "./license";

describe("racerLicenseState / racerNeedsLicense", () => {
  it("verified licensed → never charged (even when flagged new)", () => {
    const m = { isNewRacer: true, licenseActive: true };
    expect(racerLicenseState(m)).toBe("active");
    expect(racerNeedsLicense(m)).toBe(false);
  });

  it("THE LAPSED CASE: returning racer, verified with no active licence → charged", () => {
    const m = { isNewRacer: false, licenseActive: false };
    expect(racerLicenseState(m)).toBe("none");
    expect(racerNeedsLicense(m)).toBe(true);
  });

  it("unread licence status falls back to the new-racer flag, both ways", () => {
    expect(racerNeedsLicense({ isNewRacer: true })).toBe(true);
    expect(racerNeedsLicense({ isNewRacer: false })).toBe(false);
    expect(racerLicenseState({ isNewRacer: false })).toBe("unknown");
  });

  it("licensePrepaid (race-pack hand-off) counts as holding one", () => {
    const m = { isNewRacer: true, licensePrepaid: true };
    expect(racerLicenseState(m)).toBe("active");
    expect(racerNeedsLicense(m)).toBe(false);
    // …and beats a stale false from an earlier read.
    expect(racerNeedsLicense({ isNewRacer: true, licensePrepaid: true, licenseActive: false })).toBe(
      false,
    );
  });

  it("never infers from the membership NAME list (a narrow list must not charge)", () => {
    // The list is filtered to 'relevant' names by several callers; a caller that
    // populated it without the licence row would otherwise surprise-charge a
    // licensed racer. Only the explicit verified flag counts.
    const licensedButNarrowList = {
      isNewRacer: false,
      memberships: ["League Racer"],
    } as Parameters<typeof racerNeedsLicense>[0];
    expect(racerNeedsLicense(licensedButNarrowList)).toBe(false);
  });

  it("racersNeedingLicense picks exactly the owing racers", () => {
    const party = [
      { id: "a", isNewRacer: true, licenseActive: false },
      { id: "b", isNewRacer: false, licenseActive: true },
      { id: "c", isNewRacer: false, licenseActive: false },
      { id: "d", isNewRacer: false },
    ];
    expect(racersNeedingLicense(party).map((m) => m.id)).toEqual(["a", "c"]);
  });
});
