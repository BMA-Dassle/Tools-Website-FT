import { describe, it, expect } from "vitest";
import { formatLanes } from "./lanes";

describe("formatLanes", () => {
  it("says a consecutive run the way a person would", () => {
    // Owner 2026-08-11: "if they have lanes 1,2,3,4 it should show Lanes 1-4".
    expect(formatLanes("1,2,3,4")).toBe("Lanes 1–4");
    expect(formatLanes("1-4")).toBe("Lanes 1–4");
    expect(formatLanes("11 12")).toBe("Lanes 11–12");
  });

  it("lists non-consecutive lanes", () => {
    expect(formatLanes("11 & 14")).toBe("Lanes 11 & 14");
    expect(formatLanes("2, 5, 9")).toBe("Lanes 2 & 5 & 9");
  });

  it("keeps a single lane singular", () => {
    expect(formatLanes("11")).toBe("Lane 11");
  });

  it("dedupes and sorts whatever ordering the opener typed", () => {
    expect(formatLanes("4, 2, 3, 1, 2")).toBe("Lanes 1–4");
  });

  it("shows a non-numeric label verbatim rather than hiding it", () => {
    expect(formatLanes("VIP Suite")).toBe("Lane VIP Suite");
  });

  it("is null for nothing", () => {
    expect(formatLanes(null)).toBeNull();
    expect(formatLanes("")).toBeNull();
    expect(formatLanes("   ")).toBeNull();
  });
});
