import { describe, it, expect } from "vitest";
import {
  computeJoinPlan,
  habMinusOneDay,
  habTodayYmd,
  HAB_TOTAL_WEEKS,
  HAB_WEEKLY_TOTAL_CENTS,
  HAB_SEASON_TOTAL_CENTS,
  HAB_CANCEL_DATE,
  HAB_SEASON_START,
  HAB_LAST_CHARGE_DATE,
} from "./schedule";

describe("have-a-ball schedule — shared by quote (display) + join (charge)", () => {
  it("season total is 12 × $21.30 = $255.60", () => {
    expect(HAB_WEEKLY_TOTAL_CENTS).toBe(2130);
    expect(HAB_SEASON_TOTAL_CENTS).toBe(25560);
    expect(HAB_TOTAL_WEEKS).toBe(12);
  });

  it("pre-season: no back-pay, full 12-week sub from May 26", () => {
    const p = computeJoinPlan("2026-05-01");
    expect(p.status).toBe("preseason");
    expect(p.backPayWeeks).toBe(0);
    expect(p.backPayAmountCents).toBe(0);
    expect(p.subStartDate).toBe(HAB_SEASON_START);
    expect(p.remainingCharges).toBe(12);
  });

  it("on season-start day (May 26): that day is back-pay, sub starts Jun 2", () => {
    const p = computeJoinPlan("2026-05-26");
    expect(p.status).toBe("midseason");
    expect(p.backPayWeeks).toBe(1);
    expect(p.backPayAmountCents).toBe(2130);
    expect(p.subStartDate).toBe("2026-06-02");
    expect(p.remainingCharges).toBe(11);
  });

  it("joining on Tue June 9 → 3 back-pay weeks, sub starts June 16, 9 charges", () => {
    const p = computeJoinPlan("2026-06-09");
    expect(p.status).toBe("midseason");
    expect(p.backPayWeeks).toBe(3); // May 26, Jun 2, Jun 9
    expect(p.backPayAmountCents).toBe(6390); // 3 × $21.30
    expect(p.subStartDate).toBe("2026-06-16");
    expect(p.remainingCharges).toBe(9);
    expect(p.canceledDate).toBe(HAB_CANCEL_DATE);
  });

  it("mid-week (non-Tuesday) joins use the most recent Tuesday as the boundary", () => {
    // Thu Jun 11 — same as Jun 9: Jun 9 already played, next charge Jun 16.
    const p = computeJoinPlan("2026-06-11");
    expect(p.backPayWeeks).toBe(3);
    expect(p.subStartDate).toBe("2026-06-16");
    expect(p.remainingCharges).toBe(9);
  });

  it("every join date keeps the season total identical (back-pay + sub)", () => {
    for (const today of ["2026-05-26", "2026-06-09", "2026-07-01", "2026-08-04", "2026-08-11"]) {
      const p = computeJoinPlan(today);
      expect(p.backPayWeeks + p.remainingCharges).toBe(HAB_TOTAL_WEEKS);
      const subTotal = p.remainingCharges * HAB_WEEKLY_TOTAL_CENTS;
      expect(p.backPayAmountCents + subTotal).toBe(HAB_SEASON_TOTAL_CENTS);
    }
  });

  it("final charge day (Aug 11): all 12 weeks back-pay, no remaining sub charges", () => {
    const p = computeJoinPlan("2026-08-11");
    expect(p.status).toBe("midseason");
    expect(p.backPayWeeks).toBe(12);
    expect(p.remainingCharges).toBe(0);
  });

  it("after season end (Aug 12+): closed", () => {
    const p = computeJoinPlan("2026-08-12");
    expect(p.status).toBe("closed");
    expect(p.remainingCharges).toBe(0);
    expect(p.subStartDate).toBe(HAB_LAST_CHARGE_DATE);
  });

  it("habMinusOneDay subtracts a day, incl. month boundaries (Square +1 shift fix)", () => {
    expect(habMinusOneDay("2026-06-16")).toBe("2026-06-15"); // send Mon → Square stores Tue 06-16
    expect(habMinusOneDay("2026-08-18")).toBe("2026-08-17"); // cap: send → Square stores 08-18
    expect(habMinusOneDay("2026-07-01")).toBe("2026-06-30"); // month rollover
    expect(habMinusOneDay("2026-01-01")).toBe("2025-12-31"); // year rollover
  });

  it("habTodayYmd returns a YYYY-MM-DD string in ET", () => {
    // A UTC instant that is still the previous day in ET (00:30 UTC = 20:30 ET prior day)
    const ymd = habTodayYmd(new Date("2026-06-10T00:30:00Z"));
    expect(ymd).toBe("2026-06-09");
  });
});
