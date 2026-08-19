import { describe, expect, it } from "vitest";
import { mintForSigningVerdict } from "./mint-for-signing";

const IDENTITY = { email: "amy@example.com", phone: "5705751239" };

describe("mintForSigningVerdict", () => {
  it("mints when we hold BOTH a dedup identity and a birthdate", () => {
    expect(mintForSigningVerdict({ ...IDENTITY, dobIso: "1981-07-30" })).toEqual({
      kind: "mint",
      birthdate: "1981-07-30",
    });
    // Either half of the identity is enough on its own.
    expect(mintForSigningVerdict({ email: "a@b.c", dobIso: "1981-07-30" }).kind).toBe("mint");
    expect(mintForSigningVerdict({ phone: "5705751239", dobIso: "1981-07-30" }).kind).toBe("mint");
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR (2026-08-19). A looked-up adult with no
   * birthDate used to be minted anyway: the new record answers Pandora 500 for
   * ever, so every waiver check reads "no waiver" and the guest cannot be
   * scheduled — and the waiver we then sign lands on that unreadable record.
   */
  it("NEVER mints without a birthdate — it signs with the id we already hold", () => {
    const v = mintForSigningVerdict({ ...IDENTITY, fallbackId: "63000000008819494" });
    expect(v).toEqual({ kind: "use", personId: "63000000008819494" });
  });

  it("treats an empty or blank birthdate exactly like a missing one", () => {
    for (const dobIso of [undefined, null, "", "   "]) {
      expect(mintForSigningVerdict({ ...IDENTITY, dobIso, fallbackId: "77" }).kind).toBe("use");
    }
  });

  it("refuses a birthdate BMI cannot store — a malformed one mints an unreadable record too", () => {
    for (const dobIso of ["07/30/1981", "1981-7-30", "30-07-1981", "1981"]) {
      expect(mintForSigningVerdict({ ...IDENTITY, dobIso, fallbackId: "77" }).kind).toBe("use");
    }
  });

  it("blocks when there is nothing to sign with and nothing safe to create", () => {
    expect(mintForSigningVerdict({ ...IDENTITY })).toEqual({
      kind: "blocked",
      reason: "no-birthdate",
    });
    expect(mintForSigningVerdict({ dobIso: "1981-07-30" })).toEqual({
      kind: "blocked",
      reason: "no-identity",
    });
    expect(mintForSigningVerdict({})).toEqual({ kind: "blocked", reason: "no-identity" });
  });

  it("prefers the fresh readable record over the fallback when it can have one", () => {
    // Holding an id is not a reason to skip a mint we can make readable — that
    // is the short-id resolution the guardian rails still depend on.
    expect(
      mintForSigningVerdict({ ...IDENTITY, dobIso: "1981-07-30", fallbackId: "63000000008819494" }),
    ).toEqual({ kind: "mint", birthdate: "1981-07-30" });
  });

  it("ignores a whitespace-only identity or fallback", () => {
    expect(mintForSigningVerdict({ email: "  ", phone: "  ", dobIso: "1981-07-30" })).toEqual({
      kind: "blocked",
      reason: "no-identity",
    });
    expect(mintForSigningVerdict({ ...IDENTITY, fallbackId: "   " })).toEqual({
      kind: "blocked",
      reason: "no-birthdate",
    });
  });
});
