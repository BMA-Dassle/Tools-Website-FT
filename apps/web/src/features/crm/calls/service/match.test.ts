import { describe, expect, it } from "vitest";
import { callerLabel, isExtensionDn, lastTen, repForExtension, sameNumber, toE164 } from "./match";
import type { CrmRep } from "../../core/types";

/** The pure half of the matcher — the half that decides whether a guest is found. */

function rep(partial: Partial<CrmRep>): CrmRep {
  return {
    id: "1",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: "kelsea@headpinz.com",
    ssoSub: null,
    bmiUserId: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: [],
    active: true,
    sortOrder: 1,
    ...partial,
  };
}

describe("toE164", () => {
  it("normalises every shape 3CX and our capture actually produce", () => {
    expect(toE164("+12395551234")).toBe("+12395551234");
    expect(toE164("2395551234")).toBe("+12395551234");
    expect(toE164("12395551234")).toBe("+12395551234");
    expect(toE164("(239) 555-1234")).toBe("+12395551234");
    expect(toE164("239-555-1234")).toBe("+12395551234");
  });

  it("never throws on the rubbish a PBX sends", () => {
    expect(toE164(null)).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("   ")).toBeNull();
    // A failed outbound leg in the live capture carried `DestinationCallerId: "50"`.
    expect(toE164("50")).toBe("50");
    expect(toE164("Anonymous")).toBeNull();
  });
});

describe("lastTen / sameNumber", () => {
  it("matches the same handset across every spelling", () => {
    expect(lastTen("+12395551234")).toBe("2395551234");
    expect(lastTen("(239) 555-1234")).toBe("2395551234");
    expect(sameNumber("+12395551234", "239-555-1234")).toBe(true);
  });

  it("refuses to match on fewer than ten digits, so an extension matches nobody", () => {
    expect(lastTen("9027")).toBeNull();
    expect(lastTen("50")).toBeNull();
    expect(sameNumber("9027", "9027")).toBe(false);
    expect(sameNumber(null, null)).toBe(false);
  });

  it("two different guests do not collide", () => {
    expect(sameNumber("+12395551234", "+12395550199")).toBe(false);
  });
});

describe("isExtensionDn", () => {
  it("knows a DN from a trunk id and an E.164", () => {
    expect(isExtensionDn("9027")).toBe(true);
    expect(isExtensionDn("10000")).toBe(true); // the trunk IS a short DN
    expect(isExtensionDn("+12395551234")).toBe(false);
    expect(isExtensionDn("")).toBe(false);
    expect(isExtensionDn(null)).toBe(false);
  });
});

describe("repForExtension", () => {
  const roster = [
    rep({ id: "7", slug: "kelsea", threecxExtension: "9025" }),
    rep({ id: "8", slug: "lori", threecxExtension: null }),
  ];

  it("finds the rep on that DN", () => {
    expect(repForExtension("9025", roster)?.id).toBe("7");
  });

  it("is null for an unmapped extension, which is the seeded state today", () => {
    expect(repForExtension("9027", roster)).toBeNull();
    expect(repForExtension(null, roster)).toBeNull();
    expect(repForExtension("", roster)).toBeNull();
  });
});

describe("callerLabel", () => {
  it("keeps a real name", () => {
    expect(callerLabel("Renee Alvarado", "+12395556120")).toBe("Renee Alvarado");
  });

  it("drops the PBX repeating the number back at us", () => {
    // Observed live: an unknown caller's SourceDisplayName IS the E.164.
    expect(callerLabel("+12395550199", "+12395550199")).toBeNull();
    expect(callerLabel("(239) 555-0199", "+12395550199")).toBeNull();
    expect(callerLabel("", "+12395550199")).toBeNull();
    expect(callerLabel(null, null)).toBeNull();
  });
});
