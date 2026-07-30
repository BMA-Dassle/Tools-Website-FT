import { describe, it, expect } from "vitest";
import {
  COMP_TOKEN_DENOMINATIONS,
  gameCardGrantFromCompName,
  gameCardGrantFromPackageId,
  isVoucherPackageId,
} from "./grants";

describe("gameCardGrantFromCompName", () => {
  it("reads the live BMI batch name (2026-07-29)", () => {
    const g = gameCardGrantFromCompName("Complimentary 100 Token Game Card");
    expect(g).toEqual({
      packageId: "gzv-100",
      tokens: 0,
      bonusTokens: 100,
      bonusCashDollars: 0,
      label: "100 bonus tokens",
    });
  });

  it("comps land in the BONUS bucket, never the purchased one", () => {
    // Purchased vs promo value is tracked and refunded separately upstream —
    // a comp must never look like a sale.
    for (const n of COMP_TOKEN_DENOMINATIONS) {
      const g = gameCardGrantFromCompName(`Complimentary ${n} Token Game Card`);
      expect(g?.tokens).toBe(0);
      expect(g?.bonusTokens).toBe(n);
    }
  });

  it("tolerates casing, extra whitespace and trailing instructions", () => {
    // BMI's "name" is free-form setup text — the live gel comp is a whole
    // sentence — so trailing prose must not break the match.
    expect(
      gameCardGrantFromCompName(
        "complimentary  200   token game card. Redeem on a kiosk or at guest services.",
      )?.bonusTokens,
    ).toBe(200);
  });

  it("refuses denominations we don't sell — a typo cannot mint a fortune", () => {
    expect(gameCardGrantFromCompName("Complimentary 1000000 Token Game Card")).toBeNull();
    expect(gameCardGrantFromCompName("Complimentary 75 Token Game Card")).toBeNull();
    expect(gameCardGrantFromCompName("Complimentary 0 Token Game Card")).toBeNull();
  });

  it("refuses anything that isn't the strict shape", () => {
    for (const name of [
      "Race Comp",
      "Complimentary Gel Blasters. Redeem on a kiosk or at guest services.",
      "Complimentary 1 Hour Shuffly",
      "100 Token Game Card", // no "Complimentary" prefix
      "Free 100 Token Game Card",
      "Complimentary Game Card", // no denomination
      "",
      null,
      undefined,
    ]) {
      expect(gameCardGrantFromCompName(name)).toBeNull();
    }
  });

  it("does not steal a future attraction comp that mentions a card", () => {
    // voucherTarget checks game-card FIRST, which is only safe because this
    // matcher is strict. Guard that assumption.
    expect(gameCardGrantFromCompName("Complimentary Duckpin Game Card")).toBeNull();
  });
});

describe("gameCardGrantFromPackageId", () => {
  it("round-trips the id a ledger row stores", () => {
    const fromName = gameCardGrantFromCompName("Complimentary 500 Token Game Card");
    expect(gameCardGrantFromPackageId(fromName!.packageId)).toEqual(fromName);
  });

  it("refuses an off-allowlist or malformed id (hand-edited row)", () => {
    expect(gameCardGrantFromPackageId("gzv-99999")).toBeNull();
    expect(gameCardGrantFromPackageId("gzv-")).toBeNull();
    expect(gameCardGrantFromPackageId("gzv-abc")).toBeNull();
    expect(gameCardGrantFromPackageId("gzv-100.5")).toBeNull();
    expect(gameCardGrantFromPackageId("tok-100")).toBeNull();
    expect(gameCardGrantFromPackageId(null)).toBeNull();
  });
});

describe("isVoucherPackageId", () => {
  it("separates comp rows from sellable packages", () => {
    expect(isVoucherPackageId("gzv-100")).toBe(true);
    expect(isVoucherPackageId("tok-100")).toBe(false);
    expect(isVoucherPackageId("tok-upsell-100")).toBe(false);
    expect(isVoucherPackageId(null)).toBe(false);
  });
});
