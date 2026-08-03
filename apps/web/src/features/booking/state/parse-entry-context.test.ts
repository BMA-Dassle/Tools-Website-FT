import { describe, expect, it } from "vitest";
import { EMPTY_ENTRY_CONTEXT } from "./entry-context";
import { parseEntryContextFromSearchParams } from "./parse-entry-context";

describe("parseEntryContextFromSearchParams", () => {
  it("returns the empty sentinel when no params match", () => {
    expect(parseEntryContextFromSearchParams({})).toBe(EMPTY_ENTRY_CONTEXT);
    expect(parseEntryContextFromSearchParams({ unrelated: "x" })).toBe(EMPTY_ENTRY_CONTEXT);
  });

  it("extracts memberId from ?member", () => {
    expect(parseEntryContextFromSearchParams({ member: "12345" })).toEqual({ memberId: "12345" });
  });

  it("trims surrounding whitespace and ignores blanks", () => {
    expect(parseEntryContextFromSearchParams({ member: "  12345  " })).toEqual({
      memberId: "12345",
    });
    expect(parseEntryContextFromSearchParams({ member: "   " })).toBe(EMPTY_ENTRY_CONTEXT);
  });

  it("extracts promo with source = url", () => {
    expect(parseEntryContextFromSearchParams({ promo: "SUMMER25" })).toEqual({
      promo: { code: "SUMMER25", source: "url" },
    });
  });

  it("prefers referrer > ref > utm_source", () => {
    expect(parseEntryContextFromSearchParams({ referrer: "a", ref: "b", utm_source: "c" })).toEqual(
      { referrer: "a" },
    );
    expect(parseEntryContextFromSearchParams({ ref: "b", utm_source: "c" })).toEqual({
      referrer: "b",
    });
    expect(parseEntryContextFromSearchParams({ utm_source: "c" })).toEqual({ referrer: "c" });
  });

  it("builds prefilledContact only with fields that were present", () => {
    expect(parseEntryContextFromSearchParams({ firstName: "Alex", email: "a@b.co" })).toEqual({
      prefilledContact: { firstName: "Alex", email: "a@b.co" },
    });
  });

  it("omits prefilledContact entirely when every contact param is blank", () => {
    expect(parseEntryContextFromSearchParams({ firstName: "", email: "   " })).toBe(
      EMPTY_ENTRY_CONTEXT,
    );
  });

  it("takes the first non-blank value when a key repeats", () => {
    expect(parseEntryContextFromSearchParams({ promo: ["", "  ", "SECOND"] })).toEqual({
      promo: { code: "SECOND", source: "url" },
    });
  });

  it("extracts worldCup from ?experience=world-cup only", () => {
    expect(parseEntryContextFromSearchParams({ experience: "world-cup" })).toEqual({
      worldCup: true,
    });
    expect(
      parseEntryContextFromSearchParams({ experience: "world-cup", location: "fort-myers" }),
    ).toEqual({ worldCup: true, center: "fort-myers" });
    // Unknown experience values are ignored — marketing links never 500 a wizard.
    expect(parseEntryContextFromSearchParams({ experience: "pizza-party" })).toBe(
      EMPTY_ENTRY_CONTEXT,
    );
    expect(parseEntryContextFromSearchParams({ experience: "   " })).toBe(EMPTY_ENTRY_CONTEXT);
  });

  it("composes a fully prefilled session", () => {
    expect(
      parseEntryContextFromSearchParams({
        member: "M-100",
        promo: "VIP",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phone: "239-555-1212",
        utm_source: "email-spring-2026",
      }),
    ).toEqual({
      memberId: "M-100",
      promo: { code: "VIP", source: "url" },
      referrer: "email-spring-2026",
      prefilledContact: {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phone: "239-555-1212",
      },
    });
  });
});

describe("bowlingV3 preview param", () => {
  it("only the exact value '1' opts in", () => {
    expect(parseEntryContextFromSearchParams({ bowlingV3: "1" })).toEqual({ bowlingV3: true });
    expect(parseEntryContextFromSearchParams({ bowlingV3: "true" })).toBe(EMPTY_ENTRY_CONTEXT);
    expect(parseEntryContextFromSearchParams({ bowlingV3: "" })).toBe(EMPTY_ENTRY_CONTEXT);
  });
});

describe("?voucher= prepaid deal-pack hand-off", () => {
  it("normalises a single hyphenated code", () => {
    expect(parseEntryContextFromSearchParams({ voucher: "hpw-4k7m-9pqr" })).toEqual({
      voucherCodes: ["HPW4K7M9PQR"],
    });
  });

  it("accepts a comma-separated list for a multi-pack buy", () => {
    expect(
      parseEntryContextFromSearchParams({ voucher: "HPW-4K7M-9PQR,HPW-AAAA-BBBB" }),
    ).toEqual({ voucherCodes: ["HPW4K7M9PQR", "HPWAAAABBBB"] });
  });

  it("drops anything that isn't a well-formed HPW code", () => {
    // The value comes off a URL. A BMI-shaped code belongs on the other rail, and
    // junk must not reach the peek endpoint at all.
    expect(parseEntryContextFromSearchParams({ voucher: "SUMMER26" })).toBe(EMPTY_ENTRY_CONTEXT);
    expect(parseEntryContextFromSearchParams({ voucher: "A2B3C4D5E6F7G8H9J2K3M4N5" })).toBe(
      EMPTY_ENTRY_CONTEXT,
    );
    expect(parseEntryContextFromSearchParams({ voucher: "" })).toBe(EMPTY_ENTRY_CONTEXT);
    // Mixed: keep the good one, drop the rest.
    expect(parseEntryContextFromSearchParams({ voucher: "junk,HPW-4K7M-9PQR,,x" })).toEqual({
      voucherCodes: ["HPW4K7M9PQR"],
    });
  });

  it("dedupes and caps the list so a hostile URL can't fan out server peeks", () => {
    expect(
      parseEntryContextFromSearchParams({ voucher: "HPW-4K7M-9PQR,HPW-4K7M-9PQR" }),
    ).toEqual({ voucherCodes: ["HPW4K7M9PQR"] });

    // 12 distinct valid codes → capped at the 10 a buyer could legitimately hold.
    const many = Array.from({ length: 12 }, (_, i) => `HPW4K7M9PQ${i.toString(36).toUpperCase()}`);
    const parsed = parseEntryContextFromSearchParams({ voucher: many.join(",") });
    expect(parsed.voucherCodes?.length).toBeLessThanOrEqual(10);
  });
});
