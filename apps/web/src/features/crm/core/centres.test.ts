import { describe, expect, it } from "vitest";
import {
  FASTTRAX_CENTER_CODE,
  FASTTRAX_QAMF_CENTER_ID,
  HEADPINZ_FM_CENTER_CODE,
  HEADPINZ_FM_CENTER_ID,
  HEADPINZ_NAPLES_CENTER_CODE,
  HEADPINZ_NAPLES_CENTER_ID,
  QAMF_ID_TO_CENTER_CODE,
} from "@/lib/qamf-centers";
import { PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { LOCATION_NAMES, LOCATION_TO_CLIENT_KEY } from "~/features/daily-events/constants";
import {
  CENTRES,
  CENTRE_CODES,
  CENTRE_LIST,
  OFFICE_CLIENT_KEYS,
  centreByLocationId,
  centreByPandoraLocationId,
  centresForClientKey,
  isCentreCode,
} from "./centres";

/**
 * The fourth copy of the centre constants must agree with the three it copies.
 * A drift here is how a Naples lead gets minted at Fort Myers.
 */
describe("CENTRES agrees with the three upstream constant files", () => {
  it("QAMF centre ids and Square location codes (lib/qamf-centers.ts)", () => {
    expect(CENTRES.HPFM.qamfCenterId).toBe(HEADPINZ_FM_CENTER_ID);
    expect(CENTRES.FT.qamfCenterId).toBe(FASTTRAX_QAMF_CENTER_ID);
    expect(CENTRES.HPN.qamfCenterId).toBe(HEADPINZ_NAPLES_CENTER_ID);
    // The Pandora location id IS the Square location code.
    expect(CENTRES.HPFM.pandoraLocationId).toBe(HEADPINZ_FM_CENTER_CODE);
    expect(CENTRES.FT.pandoraLocationId).toBe(FASTTRAX_CENTER_CODE);
    expect(CENTRES.HPN.pandoraLocationId).toBe(HEADPINZ_NAPLES_CENTER_CODE);
    for (const c of CENTRE_LIST) {
      expect(QAMF_ID_TO_CENTER_CODE[c.qamfCenterId]).toBe(c.pandoraLocationId);
    }
  });

  it("Pandora location ids (lib/pandora-locations.ts)", () => {
    expect(CENTRES.HPFM.pandoraLocationId).toBe(PANDORA_LOCATION_MAP.headpinz);
    expect(CENTRES.FT.pandoraLocationId).toBe(PANDORA_LOCATION_MAP.fasttrax);
    expect(CENTRES.HPN.pandoraLocationId).toBe(PANDORA_LOCATION_MAP.naples);
    expect(new Set(CENTRE_LIST.map((c) => c.pandoraLocationId))).toEqual(
      new Set(Object.values(PANDORA_LOCATION_MAP)),
    );
  });

  it("location ids, client keys and names (daily-events/constants.ts)", () => {
    for (const c of CENTRE_LIST) {
      expect(LOCATION_TO_CLIENT_KEY[c.locationId], c.code).toBe(c.clientKey);
      expect(LOCATION_NAMES[c.locationId], c.code).toBe(c.name);
      expect(c.sevenShiftsLocationId).toBe(c.locationId);
    }
    expect(new Set(CENTRE_LIST.map((c) => c.locationId))).toEqual(
      new Set(Object.keys(LOCATION_TO_CLIENT_KEY).map(Number)),
    );
  });

  it("uses the booking stack's centre slugs", () => {
    // `lib/bmi-office-actions.ts` CLIENT_KEYS is keyed by exactly these.
    expect(CENTRE_LIST.map((c) => c.centerCode)).toEqual(["fort-myers", "fasttrax", "naples"]);
  });
});

describe("lookups", () => {
  it("shares one Office tenant between the two Fort Myers centres", () => {
    expect(centresForClientKey("headpinzftmyers").map((c) => c.code)).toEqual(["HPFM", "FT"]);
    expect(centresForClientKey("headpinznaples").map((c) => c.code)).toEqual(["HPN"]);
    expect(OFFICE_CLIENT_KEYS).toEqual(["headpinzftmyers", "headpinznaples"]);
  });

  it("resolves by location id and Pandora id, and refuses strangers", () => {
    expect(centreByLocationId(467486)?.code).toBe("FT");
    expect(centreByLocationId(1)).toBeNull();
    expect(centreByPandoraLocationId("PPTR5G2N0QXF7")?.code).toBe("HPN");
    expect(centreByPandoraLocationId("nope")).toBeNull();
  });

  it("keeps the display order and the code guard", () => {
    expect(CENTRE_CODES).toEqual(["HPFM", "FT", "HPN"]);
    expect(isCentreCode("FT")).toBe(true);
    expect(isCentreCode("ft")).toBe(false);
    expect(isCentreCode(9172)).toBe(false);
  });
});
