import { describe, it, expect } from "vitest";
import {
  computeJoinPlan,
  habMinusOneDay,
  habPlanVariationForRemaining,
  habTodayYmd,
  HAB_PLAN_VARIATION_BY_REMAINING,
  HAB_PLAN_VARIATION_ID,
  HAB_TOTAL_WEEKS,
  HAB_WEEKLY_TOTAL_CENTS,
  HAB_SEASON_TOTAL_CENTS,
  HAB_SEASON_START,
  HAB_LAST_CHARGE_DATE,
} from "./schedule";

describe("have-a-ball schedule — shared by quote (display) + join (charge)", () => {
  it("season total is 12 × $21.30 = $255.60", () => {
    expect(HAB_WEEKLY_TOTAL_CENTS).toBe(2130);
    expect(HAB_SEASON_TOTAL_CENTS).toBe(25560);
    expect(HAB_TOTAL_WEEKS).toBe(12);
  });

  it("pre-season: no missed weeks, full 12-week sub from May 26", () => {
    const p = computeJoinPlan("2026-05-01");
    expect(p.status).toBe("preseason");
    expect(p.missedWeeks).toBe(0);
    expect(p.retroAmountCents).toBe(0);
    expect(p.subStartDate).toBe(HAB_SEASON_START);
    expect(p.remainingCharges).toBe(12);
    expect(p.totalDueCents).toBe(12 * HAB_WEEKLY_TOTAL_CENTS);
  });

  it("on season-start day (May 26): that day is a missed/retro week, sub starts Jun 2", () => {
    const p = computeJoinPlan("2026-05-26");
    expect(p.status).toBe("midseason");
    expect(p.missedWeeks).toBe(1);
    expect(p.retroAmountCents).toBe(2130);
    expect(p.subStartDate).toBe("2026-06-02");
    expect(p.remainingCharges).toBe(11);
    expect(p.totalDueCents).toBe(11 * HAB_WEEKLY_TOTAL_CENTS);
  });

  it("joining on Tue June 9 → 3 missed weeks (retro), sub starts June 16, 9 charges", () => {
    const p = computeJoinPlan("2026-06-09");
    expect(p.status).toBe("midseason");
    expect(p.missedWeeks).toBe(3); // May 26, Jun 2, Jun 9
    expect(p.retroAmountCents).toBe(6390); // 3 × $21.30 — disclosure only
    expect(p.subStartDate).toBe("2026-06-16");
    expect(p.remainingCharges).toBe(9);
    expect(p.totalDueCents).toBe(9 * HAB_WEEKLY_TOTAL_CENTS); // only the weeks left are charged
  });

  it("mid-week (non-Tuesday) joins use the most recent Tuesday as the boundary", () => {
    // Thu Jun 11 — same as Jun 9: Jun 9 already played, next charge Jun 16.
    const p = computeJoinPlan("2026-06-11");
    expect(p.missedWeeks).toBe(3);
    expect(p.subStartDate).toBe("2026-06-16");
    expect(p.remainingCharges).toBe(9);
  });

  it("missed + remaining always span the full season (retro is disclosure only)", () => {
    for (const today of ["2026-05-26", "2026-06-09", "2026-07-01", "2026-08-04", "2026-08-11"]) {
      const p = computeJoinPlan(today);
      expect(p.missedWeeks + p.remainingCharges).toBe(HAB_TOTAL_WEEKS);
      expect(p.retroAmountCents + p.totalDueCents).toBe(HAB_SEASON_TOTAL_CENTS);
      // The subscription only ever charges the remaining weeks.
      expect(p.totalDueCents).toBe(p.remainingCharges * HAB_WEEKLY_TOTAL_CENTS);
    }
  });

  it("final charge day (Aug 11): 12 missed weeks, no remaining sub charges", () => {
    const p = computeJoinPlan("2026-08-11");
    expect(p.status).toBe("midseason");
    expect(p.missedWeeks).toBe(12);
    expect(p.remainingCharges).toBe(0);
    expect(p.totalDueCents).toBe(0);
  });

  it("after season end (Aug 12+): closed", () => {
    const p = computeJoinPlan("2026-08-12");
    expect(p.status).toBe("closed");
    expect(p.remainingCharges).toBe(0);
    expect(p.subStartDate).toBe(HAB_LAST_CHARGE_DATE);
  });

  it("maps each remaining-charge count to a distinct plan variation (1–12)", () => {
    // 12 == the full-season variation; 1–11 are the mid-season "weeks left" ones.
    expect(habPlanVariationForRemaining(12)).toBe(HAB_PLAN_VARIATION_ID);
    for (let n = 1; n <= 12; n++) {
      expect(habPlanVariationForRemaining(n)).toMatch(/^[A-Z0-9]+$/);
    }
    const ids = Object.values(HAB_PLAN_VARIATION_BY_REMAINING);
    expect(new Set(ids).size).toBe(12); // all distinct
    expect(() => habPlanVariationForRemaining(0)).toThrow();
    expect(() => habPlanVariationForRemaining(13)).toThrow();
  });

  it("every mid-season join resolves to a variation whose period count == weeks left", () => {
    for (const today of ["2026-05-26", "2026-06-09", "2026-07-01", "2026-08-04"]) {
      const p = computeJoinPlan(today);
      expect(HAB_PLAN_VARIATION_BY_REMAINING[p.remainingCharges]).toBe(
        habPlanVariationForRemaining(p.remainingCharges),
      );
    }
  });

  it("habMinusOneDay subtracts a day, incl. month boundaries (Square +1 shift fix)", () => {
    expect(habMinusOneDay("2026-06-16")).toBe("2026-06-15"); // send Mon → Square stores Tue 06-16
    expect(habMinusOneDay("2026-07-01")).toBe("2026-06-30"); // month rollover
    expect(habMinusOneDay("2026-01-01")).toBe("2025-12-31"); // year rollover
  });

  it("habTodayYmd returns a YYYY-MM-DD string in ET", () => {
    // A UTC instant that is still the previous day in ET (00:30 UTC = 20:30 ET prior day)
    const ymd = habTodayYmd(new Date("2026-06-10T00:30:00Z"));
    expect(ymd).toBe("2026-06-09");
  });
});
