import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/guest-survey-db", () => ({
  getPromoCodeByCode: vi.fn(),
}));

import { getPromoCodeByCode } from "@/lib/guest-survey-db";
import { ensureUniquePromoCode, generatePromoCode, isGuestSurveyPromoCode } from "./reward";

const mockedGet = vi.mocked(getPromoCodeByCode);

beforeEach(() => {
  mockedGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generatePromoCode", () => {
  it("produces a string in the GS-XXXX shape (prefix + 4 alphabet chars)", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generatePromoCode();
      expect(code).toMatch(/^GS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    }
  });

  it("never emits ambiguous characters (0, O, 1, I, L)", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generatePromoCode();
      const body = code.slice(3);
      expect(body).not.toMatch(/[0O1IL]/);
    }
  });

  it("emits varied codes (sanity — not a constant generator)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i += 1) set.add(generatePromoCode());
    expect(set.size).toBeGreaterThan(40);
  });
});

describe("ensureUniquePromoCode", () => {
  it("returns the first candidate when the DB has no collision", async () => {
    mockedGet.mockResolvedValue(null);
    const code = await ensureUniquePromoCode();
    expect(code).toMatch(/^GS-/);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("retries on a collision and returns the next free candidate", async () => {
    // First call: simulate a collision; second: free.
    mockedGet
      .mockResolvedValueOnce({
        code: "GS-AAAA",
        surveyId: "x",
        squareGiftCardId: "gc",
        squareGiftCardGan: "1234",
        amountCents: 500,
        issuedAt: "2026-01-01T00:00:00.000Z",
        redeemedAt: null,
        redeemedOrderId: null,
      })
      .mockResolvedValueOnce(null);

    const code = await ensureUniquePromoCode();
    expect(code).toMatch(/^GS-/);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("throws after maxAttempts collisions", async () => {
    mockedGet.mockResolvedValue({
      code: "x",
      surveyId: "x",
      squareGiftCardId: "gc",
      squareGiftCardGan: "1234",
      amountCents: 500,
      issuedAt: "2026-01-01T00:00:00.000Z",
      redeemedAt: null,
      redeemedOrderId: null,
    });
    await expect(ensureUniquePromoCode(3)).rejects.toThrow(/promo space exhausted/i);
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });
});

describe("isGuestSurveyPromoCode", () => {
  it("matches well-formed GS-XXXX codes", () => {
    expect(isGuestSurveyPromoCode("GS-7F2A")).toBe(true);
    expect(isGuestSurveyPromoCode("GS-Z9M3")).toBe(true);
  });

  it("rejects codes that use ambiguous characters", () => {
    expect(isGuestSurveyPromoCode("GS-OOOO")).toBe(false);
    expect(isGuestSurveyPromoCode("GS-1111")).toBe(false);
    expect(isGuestSurveyPromoCode("GS-LLLL")).toBe(false);
  });

  it("rejects wrong prefix or wrong length", () => {
    expect(isGuestSurveyPromoCode("DEPX1234")).toBe(false);
    expect(isGuestSurveyPromoCode("GS-ABC")).toBe(false); // too short
    expect(isGuestSurveyPromoCode("GS-ABCDE")).toBe(false); // too long
    expect(isGuestSurveyPromoCode("gs-abcd")).toBe(false); // lowercase
  });

  it("rejects null / empty", () => {
    expect(isGuestSurveyPromoCode(null)).toBe(false);
    expect(isGuestSurveyPromoCode(undefined)).toBe(false);
    expect(isGuestSurveyPromoCode("")).toBe(false);
  });
});
