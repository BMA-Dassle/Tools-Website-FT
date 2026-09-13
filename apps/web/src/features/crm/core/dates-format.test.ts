import { describe, expect, it } from "vitest";
import { ageMinutes, daysOut, etHourOfDay, fDate, fStamp, fTime, monthKey } from "./dates";
import { durationLabel, guestsLabel, initialsOf, money, moneyExact, moneyK, pct } from "./format";

/** The prototype's clock: Saturday 2026-09-12 19:30 ET (crm-data.js:5). */
const NOW = new Date("2026-09-12T19:30:00-04:00");

describe("dates render in Eastern regardless of the runner's zone", () => {
  it("formats an instant in ET", () => {
    expect(fTime(NOW)).toBe("7:30 PM");
    expect(fStamp(NOW)).toBe("Sep 12, 7:30 PM");
    // 23:30 UTC on the 12th is still the 12th in ET; 03:30 UTC on the 13th is too.
    expect(fDate(new Date("2026-09-13T03:30:00Z"))).toBe("Sat, Sep 12");
  });

  it("formats a YYYY-MM-DD as that calendar day, never the day before", () => {
    expect(fDate("2026-10-17")).toBe("Sat, Oct 17");
    expect(fDate("2026-01-01")).toBe("Thu, Jan 1");
  });

  it("counts days out from ET-today", () => {
    expect(daysOut("2026-10-17", NOW)).toBe(35);
    expect(daysOut("2026-09-12", NOW)).toBe(0);
    expect(daysOut("2026-09-11", NOW)).toBe(-1);
    // 03:30Z on the 13th is 23:30 ET on the 12th: still 35 days out.
    expect(daysOut("2026-10-17", new Date("2026-09-13T03:30:00Z"))).toBe(35);
  });

  it("gives the ET hour-of-day the shift rules compare", () => {
    expect(etHourOfDay(NOW)).toBe(19.5);
    expect(etHourOfDay(new Date("2026-09-12T14:00:00-04:00"))).toBe(14);
  });

  it("month key and age", () => {
    expect(monthKey("2026-10-17")).toBe("2026-10");
    expect(ageMinutes("2026-09-12T18:45:00-04:00", NOW)).toBe(45);
    expect(ageMinutes(NOW, NOW)).toBe(0);
  });
});

describe("format", () => {
  it("money", () => {
    expect(money(125000)).toBe("$1,250");
    expect(money(125050)).toBe("$1,251");
    expect(moneyExact(125050)).toBe("$1,250.50");
    expect(money(null)).toBe("—");
    expect(moneyK(125000)).toBe("$1.3k");
    expect(moneyK(100000)).toBe("$1k");
    expect(moneyK(45000)).toBe("$450");
  });

  it("pct clamps and survives a zero denominator", () => {
    expect(pct(3, 4)).toBe(75);
    expect(pct(5, 4)).toBe(100);
    expect(pct(1, 0)).toBe(0);
  });

  it("durations", () => {
    expect(durationLabel(45)).toBe("45 min");
    expect(durationLabel(60)).toBe("1 h");
    expect(durationLabel(125)).toBe("2 h 05 min");
    expect(durationLabel(60 * 24 * 3 + 5)).toBe("3 d");
  });

  it("initials and plurals", () => {
    expect(initialsOf("Kelsea Kosco")).toBe("KK");
    expect(initialsOf("Guest Services")).toBe("GS");
    expect(initialsOf("Jacob")).toBe("JA");
    expect(initialsOf("")).toBe("?");
    expect(guestsLabel(1)).toBe("1 guest");
    expect(guestsLabel(60)).toBe("60 guests");
  });
});
