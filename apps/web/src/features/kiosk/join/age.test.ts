import { describe, expect, it } from "vitest";
import { isAtLeast18 } from "./age";

// Noon ET on 2026-07-20 — no timezone ambiguity.
const NOW = new Date("2026-07-20T16:00:00Z");

describe("isAtLeast18", () => {
  it("is true on the 18th birthday itself", () => {
    expect(isAtLeast18("2008-07-20", NOW)).toBe(true);
  });

  it("is false the day before the 18th birthday", () => {
    expect(isAtLeast18("2008-07-21", NOW)).toBe(false);
  });

  it("uses the venue's ET calendar, not UTC", () => {
    // 02:00 UTC on Jul 21 is still 22:00 ET on Jul 20 — someone born
    // 2008-07-21 is NOT 18 yet at the venue, even though UTC says they are.
    const lateEvening = new Date("2026-07-21T02:00:00Z");
    expect(isAtLeast18("2008-07-21", lateEvening)).toBe(false);
    // …and once ET rolls over, they are.
    const nextEtDay = new Date("2026-07-21T12:00:00Z");
    expect(isAtLeast18("2008-07-21", nextEtDay)).toBe(true);
  });

  it("treats a Feb-29 birth as reached on Mar 1 in non-leap years", () => {
    expect(isAtLeast18("2008-02-29", new Date("2026-02-28T17:00:00Z"))).toBe(false);
    expect(isAtLeast18("2008-02-29", new Date("2026-03-01T17:00:00Z"))).toBe(true);
  });

  it("is true for clearly-adult DOBs", () => {
    expect(isAtLeast18("1990-01-15", NOW)).toBe(true);
    expect(isAtLeast18("1900-06-01", NOW)).toBe(true);
  });

  it("fails closed on malformed or impossible dates", () => {
    expect(isAtLeast18("", NOW)).toBe(false);
    expect(isAtLeast18("2008-7-20", NOW)).toBe(false); // not zero-padded
    expect(isAtLeast18("07/20/2008", NOW)).toBe(false); // wrong format
    expect(isAtLeast18("2008-02-30", NOW)).toBe(false); // impossible date
    expect(isAtLeast18("2007-02-29", NOW)).toBe(false); // non-leap Feb 29
    expect(isAtLeast18("2099-01-01", NOW)).toBe(false); // future
  });
});
