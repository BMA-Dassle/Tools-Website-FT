import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/square-gift-card", () => ({
  mintDigitalGiftCard: vi.fn(),
  ensureLoyaltyEnrollment: vi.fn(),
  creditLoyaltyPoints: vi.fn(),
}));

vi.mock("@/lib/guest-survey-db", () => ({
  insertGuestSurveyPromoCode: vi.fn(),
}));

vi.mock("~/features/guest-survey/reward", () => ({
  ensureUniquePromoCode: vi.fn(),
}));

import {
  creditLoyaltyPoints,
  ensureLoyaltyEnrollment,
  mintDigitalGiftCard,
} from "@/lib/square-gift-card";
import { insertGuestSurveyPromoCode } from "@/lib/guest-survey-db";
import { ensureUniquePromoCode } from "~/features/guest-survey/reward";
import {
  GIFT_CARD_AWARD_CENTS,
  PINZ_AWARD_POINTS,
  issueReward,
  renderGiftCardAwardSms,
  renderPinzAwardSms,
} from "./rewards";

const mockedMint = vi.mocked(mintDigitalGiftCard);
const mockedEnroll = vi.mocked(ensureLoyaltyEnrollment);
const mockedCredit = vi.mocked(creditLoyaltyPoints);
const mockedInsertPromo = vi.mocked(insertGuestSurveyPromoCode);
const mockedEnsureUnique = vi.mocked(ensureUniquePromoCode);

const BASE_INPUT = {
  customerId: "CUS_TEST",
  phoneE164: "+12397762044",
  locationId: "TXBSQN0FEKQ11",
  baseKey: "abc123",
  surveyId: "survey-uuid-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Re-assert defaults after clearAllMocks (vitest behavior — see prior tests).
  mockedEnroll.mockResolvedValue({
    accountId: "loy_acct_1",
    customerId: "CUS_TEST",
    balance: 0,
    lifetimePoints: 0,
  });
  mockedCredit.mockResolvedValue({ eventId: "evt_1", newBalance: 500 });
  mockedMint.mockResolvedValue({
    giftCardId: "gc_1",
    gan: "7777111122223333",
    balanceCents: 500,
  });
  mockedInsertPromo.mockResolvedValue({
    code: "GS-7F2A",
    surveyId: "survey-uuid-1",
    squareGiftCardId: "gc_1",
    squareGiftCardGan: "7777111122223333",
    amountCents: 500,
    issuedAt: "2026-05-20T20:00:00.000Z",
    redeemedAt: null,
    redeemedOrderId: null,
  });
  mockedEnsureUnique.mockResolvedValue("GS-7F2A");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issueReward — pinz", () => {
  it("ensures loyalty enrollment then credits the locked 500 Pinz", async () => {
    const result = await issueReward({ ...BASE_INPUT, kind: "pinz" });

    expect(mockedEnroll).toHaveBeenCalledWith({
      customerId: "CUS_TEST",
      phoneE164: "+12397762044",
      baseKey: "abc123",
    });
    expect(mockedCredit).toHaveBeenCalledWith({
      accountId: "loy_acct_1",
      points: PINZ_AWARD_POINTS,
      reason: "Guest Survey Reward",
      baseKey: "abc123",
    });

    expect(result.kind).toBe("pinz");
    if (result.kind !== "pinz") return;
    expect(result.ref).toBe("evt_1");
    expect(result.value).toBe(500);
    expect(result.meta.accountId).toBe("loy_acct_1");
    expect(result.displayText).toContain("500 Pinz");
    expect(result.displayText).toContain("new balance");
  });

  it("honors a custom reason if supplied", async () => {
    await issueReward({ ...BASE_INPUT, kind: "pinz", reason: "Birthday bonus" });
    expect(mockedCredit.mock.calls[0][0].reason).toBe("Birthday bonus");
  });

  it("propagates failures from Square Loyalty", async () => {
    mockedCredit.mockRejectedValueOnce(new Error("Square 500"));
    await expect(issueReward({ ...BASE_INPUT, kind: "pinz" })).rejects.toThrow("Square 500");
  });

  it("does NOT use surveyId on Pinz path (it's gift-card-only)", async () => {
    await issueReward({ ...BASE_INPUT, kind: "pinz", surveyId: undefined });
    // No error thrown — Pinz doesn't require it.
    expect(mockedCredit).toHaveBeenCalledTimes(1);
  });
});

describe("issueReward — gift_card", () => {
  it("generates promo + mints gift card + writes the link row", async () => {
    const result = await issueReward({ ...BASE_INPUT, kind: "gift_card" });

    expect(mockedEnsureUnique).toHaveBeenCalledTimes(1);
    expect(mockedMint).toHaveBeenCalledWith({
      locationId: "TXBSQN0FEKQ11",
      amountCents: GIFT_CARD_AWARD_CENTS,
      baseKey: "abc123",
      // Production catalog discount object id for "Gift Card - Guest Survey (500.088)"
      // (default unless SQUARE_SURVEY_DISCOUNT_CATALOG_ID is set).
      discountCatalogObjectId: expect.any(String),
      // Wired through so the card lands on the customer's profile in Square.
      customerId: "CUS_TEST",
    });
    expect(mockedInsertPromo).toHaveBeenCalledWith({
      code: "GS-7F2A",
      surveyId: "survey-uuid-1",
      squareGiftCardId: "gc_1",
      squareGiftCardGan: "7777111122223333",
      amountCents: GIFT_CARD_AWARD_CENTS,
    });

    expect(result.kind).toBe("gift_card");
    if (result.kind !== "gift_card") return;
    expect(result.ref).toBe("GS-7F2A");
    expect(result.value).toBe(500);
    expect(result.meta).toEqual({
      giftCardId: "gc_1",
      gan: "7777111122223333",
      promoCode: "GS-7F2A",
    });
    expect(result.displayText).toContain("$5.00 e-gift card GS-7F2A");
  });

  it("rejects when surveyId is missing", async () => {
    await expect(
      issueReward({ ...BASE_INPUT, kind: "gift_card", surveyId: undefined }),
    ).rejects.toThrow(/surveyId is required/i);
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("propagates failures from gift-card mint without writing a promo row", async () => {
    mockedMint.mockRejectedValueOnce(new Error("Square gift-card create failed"));
    await expect(issueReward({ ...BASE_INPUT, kind: "gift_card" })).rejects.toThrow(
      /create failed/,
    );
    expect(mockedInsertPromo).not.toHaveBeenCalled();
  });
});

describe("renderPinzAwardSms / renderGiftCardAwardSms", () => {
  it("Pinz SMS includes the points + new balance + brand", () => {
    const body = renderPinzAwardSms({ points: 500, newBalance: 1500, brand: "HeadPinz" });
    expect(body).toContain("HeadPinz");
    expect(body).toContain("500 Pinz");
    expect(body).toContain("1500");
  });

  it("Gift-card SMS includes Apple Wallet + balance links, no expiration", () => {
    const body = renderGiftCardAwardSms({
      gan: "1234-5678-9012-3456",
      promoCode: "GS-7F2A",
      giftCardId: "gc_test_abc",
      brand: "HeadPinz",
    });
    expect(body).toContain("Your $5 e-gift card from HeadPinz!");
    expect(body).toContain("Card 1234-5678-9012-3456");
    expect(body).toContain("Code GS-7F2A");
    expect(body).toContain(
      "Add to Apple Wallet: https://squareup.com/apass/gc/download/personalized/gc_test_abc?source=egift",
    );
    expect(body).toContain("View balance: https://app.squareup.com/gift/balance/gc_test_abc");
    expect(body).toContain("Thanks for the feedback!");
    expect(body.toLowerCase()).not.toContain("expir");
  });
});
