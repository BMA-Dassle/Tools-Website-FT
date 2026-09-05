import { describe, expect, it } from "vitest";
import {
  COMP_KINDS,
  MEMBERSHIP_KINDS,
  clientKeyForStaffLocation,
  compKind,
  defaultMembershipExpiry,
  membershipKind,
} from "./catalog";

describe("staff-mode catalog", () => {
  it("routes Naples to its own tenant and both Fort Myers brands to one", () => {
    expect(clientKeyForStaffLocation("naples")).toBe("headpinznaples");
    expect(clientKeyForStaffLocation("fasttrax")).toBe("headpinzftmyers");
    expect(clientKeyForStaffLocation("headpinz")).toBe("headpinzftmyers");
  });

  it("licence defaults to ONE year, every other membership to 99 (owner rule)", () => {
    const from = new Date(2026, 8, 4, 12, 0, 0);
    const license = membershipKind("license")!;
    expect(defaultMembershipExpiry(license, from).getFullYear()).toBe(2027);
    for (const k of MEMBERSHIP_KINDS.filter((k) => k.key !== "license")) {
      expect(k.defaultTermYears).toBe(99);
      expect(defaultMembershipExpiry(k, from).getFullYear()).toBe(2125);
    }
  });

  it("Fort Myers ids match the Office screenshots (2026-09-04)", () => {
    const fm = (k: string) => membershipKind(k)!.kindId.headpinzftmyers;
    expect(fm("license")).toBe("11260957");
    expect(fm("qualified-intermediate")).toBe("12213012");
    expect(fm("qualified-pro")).toBe("12744844");
    expect(fm("junior-intermediate")).toBe("12757067");
    expect(fm("junior-pro")).toBe("15175025");
    expect(fm("age-override")).toBe("60303930");
    expect(fm("employee-pass")).toBe("12754847");
    const comp = (k: string) => compKind(k)!.depositKindId.headpinzftmyers;
    expect(comp("race")).toBe("11260967");
    expect(comp("gel-blaster")).toBe("24216636");
    expect(comp("laser-tag")).toBe("306564");
    expect(comp("headsock")).toBe("48069703");
    expect(comp("pov-camera")).toBe("46322806");
  });

  it("Naples has no ids yet — every chip disabled there, nothing guessed", () => {
    for (const k of MEMBERSHIP_KINDS) expect(k.kindId.headpinznaples).toBeNull();
    for (const k of COMP_KINDS) expect(k.depositKindId.headpinznaples).toBeNull();
  });

  it("keys are unique and unknown keys resolve to null", () => {
    const mk = MEMBERSHIP_KINDS.map((k) => k.key);
    expect(new Set(mk).size).toBe(mk.length);
    const ck = COMP_KINDS.map((k) => k.key);
    expect(new Set(ck).size).toBe(ck.length);
    expect(membershipKind("nope")).toBeNull();
    expect(compKind("nope")).toBeNull();
  });
});
