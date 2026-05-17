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

  it("composes a fully prefilled session", () => {
    expect(
      parseEntryContextFromSearchParams({
        member: "M-100",
        promo: "VIP",
        firstName: "Alex",
        lastName: "Trepasso",
        email: "alex@example.com",
        phone: "239-555-1212",
        utm_source: "email-spring-2026",
      }),
    ).toEqual({
      memberId: "M-100",
      promo: { code: "VIP", source: "url" },
      referrer: "email-spring-2026",
      prefilledContact: {
        firstName: "Alex",
        lastName: "Trepasso",
        email: "alex@example.com",
        phone: "239-555-1212",
      },
    });
  });
});
