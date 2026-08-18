import { describe, expect, it } from "vitest";
import { GROUPON_DEALS, itemsForDeal, resolveDealKey } from "./deals";
import { NATIVE_GRANT_DENOMINATIONS } from "~/features/game-cards/service/native-voucher";
import { COMP_TOKEN_DENOMINATIONS } from "~/features/game-cards/vouchers/grants";
import type { GrouponUnit } from "./types";

const unit: GrouponUnit = {
  id: "ae5d7713-bda1-45ee-b96f-49e12ce0048d",
  status: "available",
  grouponCode: "VS-VBGZ-M2YF-FC13-NF4K",
  redemptionCode: "WNDXH4DJ",
  redeemedAt: null,
  value: { amount: 100, currencyCode: "USD" },
  price: { amount: 1, currencyCode: "USD" },
  attributes: null,
};

describe("the arcade25-laser4 deal", () => {
  const items = GROUPON_DEALS["arcade25-laser4"].items;

  it("is ONE card plus FOUR laser tag entries", () => {
    expect(items).toHaveLength(5);
    expect(items.filter((i) => i.kind === "gamezone")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "attraction")).toHaveLength(4);
  });

  it("puts the whole $25 on one card as BONUS tokens at 10c/token", () => {
    const gz = items.find((i) => i.kind === "gamezone");
    expect(gz).toMatchObject({ tokens: 0, bonusTokens: 250, bonusCashDollars: 0 });
  });

  // The failure this guards is silent and total: a denomination missing from
  // the allowlists mints a voucher happily and then credits NOTHING when the
  // card is dispensed. The guest walks away with an empty card.
  it("grants a denomination BOTH allowlists honour", () => {
    expect(COMP_TOKEN_DENOMINATIONS).toContain(250);
    expect(NATIVE_GRANT_DENOMINATIONS).toContain(250);
  });

  it("gives each laser tag entry its own item so they claim independently", () => {
    for (const i of items.filter((x) => x.kind === "attraction")) {
      expect(i).toMatchObject({ slug: "laser-tag", qty: 1 });
    }
  });
});

describe("resolveDealKey", () => {
  it("resolves to the single configured deal", () => {
    expect(resolveDealKey(unit)).toBe("arcade25-laser4");
  });

  it("returns items for a known key and null for none", () => {
    expect(itemsForDeal("arcade25-laser4")).toHaveLength(5);
    expect(itemsForDeal(null)).toBeNull();
  });
});
