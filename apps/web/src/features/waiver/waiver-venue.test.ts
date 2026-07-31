/**
 * The center_code -> venue mapping. Every case here is a way a waiver gets filed
 * at the wrong place, which is a silent failure: the guest signs, sees a success
 * screen, and arrives to be told they have no waiver.
 *
 * The load-bearing assertion is the LAST one — that every pair this produces is a
 * pair `/api/waiver/context` will actually accept. Without it this file could
 * agree with itself while disagreeing with the route that has to serve the link.
 */
import { describe, it, expect } from "vitest";
import { waiverVenueForCenterCode } from "./waiver-venue";
import {
  CENTER_TO_BMI_LOCATION_IDS,
  BMI_LOCATION_TO_PANDORA_KEY,
} from "~/features/kiosk/waiver/locations";

describe("waiverVenueForCenterCode", () => {
  it("keeps the two Fort Myers venues apart", () => {
    // One metro, one BMI server, TWO Pandora locations. Collapsing them files a
    // FastTrax guest's waiver under HeadPinz.
    expect(waiverVenueForCenterCode("fort-myers")).toEqual({
      center: "fort-myers",
      locationId: "332160",
    });
    expect(waiverVenueForCenterCode("fasttrax")).toEqual({
      center: "fort-myers",
      locationId: "467486",
    });
  });

  it("sends Naples to Naples", () => {
    // Naples has its own Pandora location AND its own waiver template — a Naples
    // waiver filed at Fort Myers is not a valid waiver.
    expect(waiverVenueForCenterCode("naples")).toEqual({
      center: "naples",
      locationId: "332145",
    });
  });

  it("REFUSES an unknown center_code instead of defaulting", () => {
    // The whole point. Defaulting to HP-FM is the bug fixed in the Pandora waiver
    // route (d261ef7e): a wrong venue is worse than no venue, because no venue
    // degrades to the picker, which ASKS.
    // NB casing/whitespace on a KNOWN code is normalized, not rejected — see the
    // next case. These are codes that name no venue we have.
    for (const bad of [
      "",
      "  ",
      "sarasota",
      "ft-myers",
      "fort myers",
      "naples2",
      null,
      undefined,
    ]) {
      expect(waiverVenueForCenterCode(bad as string)).toBeNull();
    }
  });

  it("tolerates casing and surrounding whitespace on a KNOWN code", () => {
    expect(waiverVenueForCenterCode(" Naples ")).toEqual({
      center: "naples",
      locationId: "332145",
    });
  });

  it("never returns a numeric locationId (BMI ids stay text)", () => {
    for (const code of ["fort-myers", "fasttrax", "naples"]) {
      expect(typeof waiverVenueForCenterCode(code)!.locationId).toBe("string");
    }
  });

  it("only ever produces (center, loc) pairs /api/waiver/context accepts", () => {
    // THE contract with the rest of the system. The context route rejects a pair
    // that is not in CENTER_TO_BMI_LOCATION_IDS, so a venue this function invents
    // would 400 — after the guest clicked a link we emailed them.
    for (const code of ["fort-myers", "fasttrax", "naples"]) {
      const venue = waiverVenueForCenterCode(code)!;
      expect(CENTER_TO_BMI_LOCATION_IDS[venue.center]).toContain(Number(venue.locationId));
      // And each must resolve to a real Pandora location, since that is what the
      // waiver actually files against.
      expect(BMI_LOCATION_TO_PANDORA_KEY[Number(venue.locationId)]).toBeTruthy();
    }
  });

  it("maps the three center_codes onto three DISTINCT venues", () => {
    // Guards a copy-paste that would point two center_codes at one location and
    // silently merge two venues' waivers.
    const ids = ["fort-myers", "fasttrax", "naples"].map(
      (c) => waiverVenueForCenterCode(c)!.locationId,
    );
    expect(new Set(ids).size).toBe(3);
  });
});
