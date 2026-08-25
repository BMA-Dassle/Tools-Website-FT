import { describe, expect, it } from "vitest";
import { mintForSigningVerdict } from "./mint-for-signing";

const IDENTITY = { email: "amy@example.com", phone: "5705751239" };

describe("mintForSigningVerdict", () => {
  it("mints for a guest we hold NO id for, when the record can land readable", () => {
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

  /**
   * THE DUPLICATE LOOP (measured 2026-08-12→24: 194 guests, 256 records, 166
   * waivers stranded on a record that is not the guest's main one).
   *
   * This is the ugly real case, not a tidy one: Christopher Amodeo was LOOKED UP
   * — so we held his id — and he had a perfectly good birthdate. The old rule
   * minted anyway to resolve a "short" id, his existing waiver was invisible on
   * the new record, so he signed again; then he tapped the next child and it
   * happened again. Six records and three self-signed adult waivers in 13
   * minutes. A birthdate in hand must NOT be a reason to create a second record
   * for a guest we have already identified.
   */
  it("uses the id we already hold even when it could mint a perfectly good record", () => {
    expect(
      mintForSigningVerdict({ ...IDENTITY, dobIso: "1981-07-30", fallbackId: "63000000009076440" }),
    ).toEqual({ kind: "use", personId: "63000000009076440" });
  });

  it("uses a held id whatever the birthdate looks like — a mint is never the repair", () => {
    for (const dobIso of [undefined, null, "", "   ", "07/30/1981", "1981-7-30", "1981"]) {
      expect(
        mintForSigningVerdict({ ...IDENTITY, dobIso, fallbackId: "63000000009076440" }),
      ).toEqual({ kind: "use", personId: "63000000009076440" });
    }
  });

  it("uses a held id even with no dedup identity at all — an OTP sign-in carries neither", () => {
    expect(mintForSigningVerdict({ fallbackId: "63000000009076440" })).toEqual({
      kind: "use",
      personId: "63000000009076440",
    });
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
