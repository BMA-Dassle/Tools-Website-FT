import { describe, it, expect } from "vitest";
import { addMinutesNaive, heatStopFor } from "./schedule-racers";

describe("addMinutesNaive (naive-ET wall-clock, TZ-neutral)", () => {
  it("adds minutes without shifting the wall clock", () => {
    expect(addMinutesNaive("2026-07-20T16:12:00", 7)).toBe("2026-07-20T16:19:00");
  });
  it("crosses an hour boundary", () => {
    expect(addMinutesNaive("2026-07-20T16:58:00", 7)).toBe("2026-07-20T17:05:00");
  });
  it("tolerates a trailing Z (treats it as the same wall clock)", () => {
    expect(addMinutesNaive("2026-07-20T16:12:00Z", 7)).toBe("2026-07-20T16:19:00");
  });
  it("heatStopFor = heatStart + 7 min (HEAT_DURATION_MIN)", () => {
    expect(heatStopFor("2026-07-20T16:12:00")).toBe("2026-07-20T16:19:00");
  });
});
