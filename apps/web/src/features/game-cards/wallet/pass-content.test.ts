import { describe, expect, it } from "vitest";
import {
  buildPassMeta,
  displayCode,
  isFullySpent,
  remainingItems,
  summariseRemaining,
  voucherItemStates,
} from "./pass-content";
import { groupVoucherItems } from "../vouchers/display";
import type { VoucherItem } from "../data/vouchers-db";

const laser: VoucherItem = { kind: "attraction", slug: "laser-tag", qty: 1 };
/** $10 of play at the house 10¢/token rate — what the deal packs actually mint. */
const card10: VoucherItem = { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 };

const states = (items: VoucherItem[], spentIdx: number[] = []) =>
  voucherItemStates(items, new Set(spentIdx));

describe("summariseRemaining", () => {
  it("speaks DOLLARS, not tokens — tokens are an Intercard detail", () => {
    // The real deal-pack shape (HPW8B7HDFMN): 2 laser legs + 2 × 100 bonus
    // tokens. The pass must not say "200 Tokens" when the deal sells "$20".
    const line = summariseRemaining(states([laser, laser, card10, card10]));
    expect(line).toBe("2 × Laser Tag + 2 × $10 Game Card");
    expect(line).not.toMatch(/token/i);
  });

  it("is worded identically to how /v renders the same voucher", () => {
    // /v does: groupVoucherItems(...) then `${g.total > 1 ? g.total + ' × ' : ''}${g.label}`.
    // Two surfaces, one voucher — they must not disagree.
    const s = states([laser, laser, card10, card10]);
    const asPageRenders = groupVoucherItems(s)
      .map((g) => (g.total > 1 ? `${g.total} × ${g.label}` : g.label))
      .join(" + ");
    expect(summariseRemaining(s)).toBe(asPageRenders);
  });

  it("drops the multiplier for a single leg", () => {
    expect(summariseRemaining(states([laser, card10]))).toBe("Laser Tag + $10 Game Card");
  });

  it("uses the attraction catalog name, not the raw slug", () => {
    const line = summariseRemaining(states([{ kind: "attraction", slug: "gel-blaster", qty: 1 }]));
    expect(line).not.toContain("gel-blaster");
    expect(line).toMatch(/Gel/);
  });

  it("keeps the 'or' on a choice leg — the guest really does pick", () => {
    const line = summariseRemaining(
      states([{ kind: "attraction-choice", slugs: ["laser-tag", "gel-blaster"], qty: 1 }]),
    );
    expect(line).toContain(" or ");
  });

  it("counts only UNSPENT legs — the whole point of the pass", () => {
    // Half redeemed: one laser leg and one card leg gone.
    expect(summariseRemaining(states([laser, laser, card10, card10], [0, 2]))).toBe(
      "Laser Tag + $10 Game Card",
    );
  });

  it("summarises rather than letting the OS cut a price in half", () => {
    const line = summariseRemaining(
      states([
        { kind: "attraction-choice", slugs: ["laser-tag", "gel-blaster"], qty: 2 },
        card10,
        { kind: "race", qty: 3 },
      ]),
    );
    expect(line).toMatch(/\+ 2 more$/);
    expect(line.length).toBeLessThanOrEqual(40);
  });

  it("returns empty when nothing is left — caller decides what that means", () => {
    expect(summariseRemaining(states([card10], [0]))).toBe("");
  });
});

describe("isFullySpent", () => {
  it("ignores legs we cannot redeem — they must not hold a pass open forever", () => {
    // Card spent, laser leg unspent but has no redemption rail yet.
    expect(isFullySpent(states([card10, laser], [0]))).toBe(true);
  });

  it("is false while any redeemable leg survives", () => {
    expect(isFullySpent(states([card10, card10], [0]))).toBe(false);
  });
});

describe("remainingItems", () => {
  it("keeps unspent legs in mint order", () => {
    expect(remainingItems(states([laser, card10, laser], [1])).map((s) => s.index)).toEqual([0, 2]);
  });
});

describe("displayCode", () => {
  it("groups a native code the way the email prints it", () => {
    expect(displayCode("HPW8B7HDFMN")).toBe("HPW-8B7H-DFMN");
  });

  it("leaves anything else alone rather than mangling it", () => {
    expect(displayCode("SUMMER26")).toBe("SUMMER26");
  });
});

describe("buildPassMeta", () => {
  it("builds the barcode payload the kiosk classifier already unwraps", () => {
    const meta = buildPassMeta({
      code: "HPW8B7HDFMN",
      siteOrigin: "https://headpinz.com/",
      remaining: remainingItems(states([laser, card10])),
      expiresAt: "2027-08-04T03:59:59.000Z",
      kind: "mixed",
      batchId: "b-1",
    });
    // /v/{code} is what code-entry/classify.ts pulls the code back out of.
    expect(meta.redeemUrl).toBe("https://headpinz.com/v/HPW8B7HDFMN");
    expect(meta.code).toBe("HPW-8B7H-DFMN");
    expect(meta.voucherValue).toBe("Laser Tag + $10 Game Card");
    // ET, so a 11:59 PM ET expiry doesn't read as the next day.
    expect(meta.expires).toBe("August 3, 2027");
  });

  it("never leaves the value blank, even fully redeemed", () => {
    const meta = buildPassMeta({
      code: "HPW8B7HDFMN",
      siteOrigin: "https://headpinz.com",
      remaining: [],
      expiresAt: null,
      kind: "mixed",
      batchId: null,
    });
    expect(meta.voucherValue).toBe("Fully redeemed");
    expect(meta.expires).toBe("No expiry");
    expect(meta.batchId).toBe("");
  });
});
