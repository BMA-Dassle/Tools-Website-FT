import { describe, expect, it } from "vitest";
import { parseTime, buildTimeSlots } from "./food-time";

describe("parseTime (portal parity)", () => {
  it("parses explicit meridian forms", () => {
    expect(parseTime("4:30pm")).toBe("4:30 PM");
    expect(parseTime("4:30 PM")).toBe("4:30 PM");
    expect(parseTime("11:15am")).toBe("11:15 AM");
    expect(parseTime("12pm")).toBe("12:00 PM");
  });

  it("parses 24-hour and compact digit forms", () => {
    expect(parseTime("16:30")).toBe("4:30 PM");
    expect(parseTime("430")).toBe("4:30 PM"); // 04:30 + 1-6 PM heuristic
    expect(parseTime("1630")).toBe("4:30 PM");
  });

  it("bare 1-6 hours assume PM (events run afternoons)", () => {
    expect(parseTime("3")).toBe("3:00 PM");
    expect(parseTime("6")).toBe("6:00 PM");
    expect(parseTime("7")).toBe("7:00 AM"); // heuristic only covers 1-6
    expect(parseTime("11")).toBe("11:00 AM");
  });

  it("midnight and noon edge cases", () => {
    expect(parseTime("0")).toBe("12:00 AM");
    expect(parseTime("12")).toBe("12:00 PM");
    expect(parseTime("23:59")).toBe("11:59 PM");
  });

  it("rejects invalid input", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("7:65")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("13pm")).toBeNull();
    expect(parseTime("0am")).toBeNull();
  });
});

describe("buildTimeSlots (portal parity)", () => {
  it("builds 9 half-hour slots from an h:mm AM/PM start", () => {
    expect(buildTimeSlots("5:00 PM")).toEqual([
      "5:00 PM",
      "5:30 PM",
      "6:00 PM",
      "6:30 PM",
      "7:00 PM",
      "7:30 PM",
      "8:00 PM",
      "8:30 PM",
      "9:00 PM",
    ]);
  });

  it("rounds odd start minutes down/up like the portal", () => {
    expect(buildTimeSlots("5:15 PM")[0]).toBe("5:00 PM");
    expect(buildTimeSlots("5:45 PM")[0]).toBe("6:00 PM");
    expect(buildTimeSlots("5:30 PM")[0]).toBe("5:30 PM");
  });

  it("caps at midnight", () => {
    expect(buildTimeSlots("10:00 PM")).toEqual(["10:00 PM", "10:30 PM", "11:00 PM", "11:30 PM"]);
  });

  it("falls back to noon for unparseable input", () => {
    expect(buildTimeSlots("whenever")[0]).toBe("12:00 PM");
  });
});
