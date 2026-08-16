import { describe, expect, it } from "vitest";
import { TV_RECYCLE_HARD_MS, TV_RECYCLE_SOFT_MS, etHourNow, shouldRecycle } from "./recycle";

const HOUR = 3_600_000;

describe("shouldRecycle", () => {
  it("never recycles under the soft threshold, at any hour", () => {
    for (let h = 0; h < 24; h++) {
      expect(shouldRecycle(TV_RECYCLE_SOFT_MS - 1, h)).toBe(false);
    }
    expect(shouldRecycle(0, 3)).toBe(false);
  });

  it("recycles past the soft threshold only inside the overnight window", () => {
    const uptime = 13 * HOUR;
    expect(shouldRecycle(uptime, 3)).toBe(true);
    expect(shouldRecycle(uptime, 14)).toBe(false);
    expect(shouldRecycle(uptime, 23)).toBe(false);
  });

  it("window boundaries: 2am is in, 6am is out", () => {
    const uptime = 13 * HOUR;
    expect(shouldRecycle(uptime, 2)).toBe(true);
    expect(shouldRecycle(uptime, 5)).toBe(true);
    expect(shouldRecycle(uptime, 6)).toBe(false);
    expect(shouldRecycle(uptime, 1)).toBe(false);
  });

  it("hard cap recycles regardless of hour — even an unknown one", () => {
    const uptime = TV_RECYCLE_HARD_MS + 1;
    expect(shouldRecycle(uptime, 14)).toBe(true);
    expect(shouldRecycle(uptime, -1)).toBe(true);
  });

  it("an evening-booted screen waits for its second overnight window — never a daily trading-hours reload", () => {
    // Boot (or deploy-reload) at 20:00. Walk the following hours: the first
    // window passes under the soft threshold (2am = 6h, 5am = 9h), 24h lands
    // back at 20:00 — the OLD hard cap fired exactly there, locking the
    // screen into a peak-hours blink every day — and the second window
    // (30h = 2am) is where it must finally go.
    const hourAt = (uptimeH: number) => (20 + uptimeH) % 24;
    let firedAtUptimeH: number | null = null;
    for (let h = 1; h <= 36 && firedAtUptimeH === null; h++) {
      if (shouldRecycle(h * HOUR, hourAt(h))) firedAtUptimeH = h;
    }
    expect(firedAtUptimeH).toBe(30);
    expect(hourAt(30)).toBe(2);
  });

  it("an unknown hour (-1) never matches the overnight window", () => {
    expect(shouldRecycle(13 * HOUR, -1)).toBe(false);
  });
});

describe("etHourNow", () => {
  it("reads the hour in venue time, not device time", () => {
    // 2026-08-16T06:30:00Z is 02:30 in America/New_York (EDT, UTC-4).
    expect(etHourNow(new Date("2026-08-16T06:30:00Z"))).toBe(2);
    // And 23:30 the previous evening at 03:30Z.
    expect(etHourNow(new Date("2026-08-16T03:30:00Z"))).toBe(23);
  });

  it("reads midnight as 0, not 24", () => {
    expect(etHourNow(new Date("2026-08-16T04:10:00Z"))).toBe(0);
  });
});
