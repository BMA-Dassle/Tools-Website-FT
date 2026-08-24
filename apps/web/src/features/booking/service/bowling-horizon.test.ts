import { describe, expect, it } from "vitest";

import { BOWLING_WEB_HORIZON_DAYS, bowlingHorizonMaxDate } from "./bowling-hours";

describe("bowlingHorizonMaxDate", () => {
  it("is 45 days — the Conqueror web-offer advance limit at both centers (2026-08-24)", () => {
    expect(BOWLING_WEB_HORIZON_DAYS).toBe(45);
  });

  it("matches the live probe: from 2026-08-24, 10/08 sells and 10/09 does not", () => {
    expect(bowlingHorizonMaxDate("2026-08-24")).toBe("2026-10-08");
    expect("2026-10-08" <= bowlingHorizonMaxDate("2026-08-24")).toBe(true);
    expect("2026-10-09" <= bowlingHorizonMaxDate("2026-08-24")).toBe(false);
  });

  it("crosses month and year boundaries as a calendar, not a fixed 30-day month", () => {
    expect(bowlingHorizonMaxDate("2026-12-01")).toBe("2027-01-15");
  });
});
