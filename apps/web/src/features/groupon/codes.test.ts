import { describe, it, expect } from "vitest";
import {
  GROUPON_CODE_RE,
  GROUPON_LONG_CODE_RE,
  looksLikeGrouponCode,
  normalizeGrouponCode,
} from "./codes";

/**
 * These regexes are PRE-FILTERS, and the only thing that can go wrong with a
 * pre-filter is the two directions of wrong: too tight turns a paying guest
 * away at the kiosk, too loose sends promo typos to a vendor API. So the tests
 * pin both edges of the length window, not just the happy shapes.
 *
 * `WNDXH4DJ` / `89895632` / `VS-GCMV-VNXS-4YN4-2V4X` are real units (staging
 * and production respectively). The 7-long form is the owner's 2026-08-22
 * report — "Groupons can also be 7 numbers instead of 8".
 */
describe("GROUPON_CODE_RE — the short form", () => {
  it("accepts the 8-character forms we have actually seen", () => {
    expect(GROUPON_CODE_RE.test("WNDXH4DJ")).toBe(true);
    expect(GROUPON_CODE_RE.test("89895632")).toBe(true);
  });

  it("accepts the 7-character forms", () => {
    expect(GROUPON_CODE_RE.test("3443126")).toBe(true);
    expect(GROUPON_CODE_RE.test("WNDXH4D")).toBe(true);
  });

  it("holds the window shut at 6 and at 9", () => {
    // 6 would swallow half the promo catalogue and every W-number-ish token;
    // 9+ is not a shape Groupon has ever handed us.
    expect(GROUPON_CODE_RE.test("343126")).toBe(false);
    expect(GROUPON_CODE_RE.test("344312655")).toBe(false);
  });

  it("is uppercase-only — callers normalize first", () => {
    expect(GROUPON_CODE_RE.test("wndxh4dj")).toBe(false);
    expect(looksLikeGrouponCode("wndxh4dj")).toBe(true);
  });

  it("rejects punctuation, so the HPW printed form cannot leak in", () => {
    expect(GROUPON_CODE_RE.test("HPW-4K7M")).toBe(false);
  });
});

describe("GROUPON_LONG_CODE_RE — the printed form", () => {
  it("matches the real production long code", () => {
    expect(GROUPON_LONG_CODE_RE.test("VS-GCMV-VNXS-4YN4-2V4X")).toBe(true);
  });

  it("is unaffected by the short-form widening", () => {
    expect(GROUPON_LONG_CODE_RE.test("VS-GCMV-VNXS-4YN4")).toBe(false);
    expect(GROUPON_LONG_CODE_RE.test("XX-GCMV-VNXS-4YN4-2V4X")).toBe(false);
  });
});

describe("looksLikeGrouponCode", () => {
  it("normalizes before matching — the kiosk OSK produces both", () => {
    expect(normalizeGrouponCode("  3443126 ")).toBe("3443126");
    expect(looksLikeGrouponCode("  3443126 ")).toBe(true);
    expect(looksLikeGrouponCode(" vs-gcmv-vnxs-4yn4-2v4x ")).toBe(true);
  });

  it("still refuses the shapes the API gate exists to keep out", () => {
    // A padded game-card barcode and a BMI voucher must never become a
    // Groupon API call — this is the pre-filter in /api/kiosk/groupon/validate.
    expect(looksLikeGrouponCode("0000000001038091")).toBe(false);
    expect(looksLikeGrouponCode("C2D8M8D6M6C9M9U9U5K7Q6R9")).toBe(false);
    expect(looksLikeGrouponCode("HPWRKEMG926")).toBe(false);
    expect(looksLikeGrouponCode("")).toBe(false);
  });
});
