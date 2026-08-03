import { describe, expect, it } from "vitest";
import { isFastTraxSubject, resolveCenter } from "@/lib/hermes-client";

/**
 * FastTrax and HeadPinz Fort Myers share one BMI client, so the ONLY thing that
 * separates them is the project's Location selector — encoded by lib/bmi-scan.ts
 * as an "FT " subject prefix. The dispatch cron's subject backstop used
 * `includes("FT")`, which also matches GIFT / LEFT / SOFT / CRAFT / DRAFT /
 * AFTER. Because the check can only ADD FastTrax and never remove it, a single
 * false positive pins an event that moved to HeadPinz back to FastTrax forever.
 */
describe("isFastTraxSubject", () => {
  it("matches the prefix bmi-scan actually emits for FastTrax", () => {
    expect(isFastTraxSubject("FT US Anesthesia Partners")).toBe(true);
    expect(isFastTraxSubject("  FT Smith Party")).toBe(true);
  });

  it("matches an explicit FastTrax mention anywhere", () => {
    expect(isFastTraxSubject("Corporate day at FastTrax")).toBe(true);
    expect(isFastTraxSubject("fast trax buyout")).toBe(true);
  });

  it("does not fire on words that merely contain FT", () => {
    for (const subject of [
      "GIFT CARD PARTY",
      "Holiday GIFT Exchange",
      "LEFT LANE LEAGUE",
      "CRAFT BEER NIGHT",
      "DRAFT DAY",
      "AFTER PROM",
      "SOFT OPENING",
    ]) {
      expect(isFastTraxSubject(subject), subject).toBe(false);
    }
  });

  it("does not fire on an ordinary HeadPinz subject or empty input", () => {
    expect(isFastTraxSubject("US Anesthesia Partners")).toBe(false);
    expect(isFastTraxSubject("")).toBe(false);
    expect(isFastTraxSubject(undefined)).toBe(false);
  });
});

describe("resolveCenter", () => {
  it("maps the shared Fort Myers host to each brand's own Square location", () => {
    expect(resolveCenter("10.48.0.14")).toMatchObject({
      centerCode: "fort-myers",
      squareLocationId: "TXBSQN0FEKQ11",
      brand: "headpinz",
      ganPrefix: "GFHPFM",
    });
    expect(resolveCenter("10.48.0.14_FT")).toMatchObject({
      centerCode: "fasttrax",
      squareLocationId: "LAB52GY480CJF",
      brand: "fasttrax",
      ganPrefix: "GFFT",
    });
  });
});
