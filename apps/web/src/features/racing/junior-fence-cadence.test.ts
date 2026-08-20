import { describe, expect, it } from "vitest";
import {
  etHourMinute,
  QUIET_END_HOUR_ET,
  QUIET_EVERY_MINUTES,
  QUIET_START_HOUR_ET,
  shouldSweepNow,
} from "./junior-fence-cadence";

describe("shouldSweepNow", () => {
  it("runs EVERY minute through every hour anyone books in", () => {
    // The measured distribution: 09:00 onwards is never quiet, peaking at 503
    // events in the 19:00 hour. Responsiveness there is the whole feature.
    for (const hour of [9, 12, 15, 17, 18, 19, 20, 21, 22, 23]) {
      for (const minute of [0, 1, 7, 29, 43, 59]) {
        expect(shouldSweepNow({ etHour: hour, etMinute: minute })).toBe(true);
      }
    }
  });

  it("keeps midnight and 1am at full rate — online sales run past midnight", () => {
    // 00:00 and 01:00 are quiet (7 and 9 events) but NOT empty, and HPFM runs
    // past midnight on weekends. Deliberately outside the throttle.
    for (const hour of [0, 1]) {
      expect(shouldSweepNow({ etHour: hour, etMinute: 37 })).toBe(true);
    }
  });

  it("drops to one run in ten through the dead window", () => {
    for (let hour = QUIET_START_HOUR_ET; hour <= QUIET_END_HOUR_ET; hour++) {
      expect(shouldSweepNow({ etHour: hour, etMinute: 0 })).toBe(true);
      expect(shouldSweepNow({ etHour: hour, etMinute: 10 })).toBe(true);
      expect(shouldSweepNow({ etHour: hour, etMinute: 1 })).toBe(false);
      expect(shouldSweepNow({ etHour: hour, etMinute: 9 })).toBe(false);
      expect(shouldSweepNow({ etHour: hour, etMinute: 59 })).toBe(false);
    }
  });

  it("resumes full rate the minute the window ends", () => {
    expect(shouldSweepNow({ etHour: QUIET_END_HOUR_ET, etMinute: 3 })).toBe(false);
    expect(shouldSweepNow({ etHour: QUIET_END_HOUR_ET + 1, etMinute: 3 })).toBe(true);
  });

  it("still sweeps six times an hour while throttled — never zero", () => {
    let runs = 0;
    for (let m = 0; m < 60; m++) {
      if (shouldSweepNow({ etHour: 4, etMinute: m })) runs++;
    }
    expect(runs).toBe(60 / QUIET_EVERY_MINUTES);
  });

  it("saves the expected share of a day", () => {
    let runs = 0;
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) if (shouldSweepNow({ etHour: h, etMinute: m })) runs++;
    }
    const quietHours = QUIET_END_HOUR_ET - QUIET_START_HOUR_ET + 1;
    expect(runs).toBe(1440 - quietHours * (60 - 60 / QUIET_EVERY_MINUTES));
    expect(runs).toBe(1062); // 1,440 -> 1,062 runs a day
  });
});

describe("etHourMinute", () => {
  it("reads the venue's clock, not the server's", () => {
    // 2026-08-20T06:33:00Z is 02:33 ET (EDT, UTC-4) — inside the dead window,
    // and :33 is not a throttle minute, so this tick is skipped.
    const { etHour, etMinute } = etHourMinute(Date.parse("2026-08-20T06:33:00Z"));
    expect(etHour).toBe(2);
    expect(etMinute).toBe(33);
    expect(shouldSweepNow({ etHour, etMinute })).toBe(false);
    // ...but :30 in the same hour IS one of the six runs we keep.
    expect(shouldSweepNow({ etHour, etMinute: 30 })).toBe(true);
  });

  it("normalises midnight to 0, never 24", () => {
    // 04:00Z is midnight ET. Some ICU builds render hour12:false midnight as 24.
    const { etHour } = etHourMinute(Date.parse("2026-08-20T04:00:00Z"));
    expect(etHour).toBe(0);
    expect(shouldSweepNow({ etHour, etMinute: 0 })).toBe(true);
  });

  it("puts the 19:00 booking peak firmly outside the throttle", () => {
    const { etHour } = etHourMinute(Date.parse("2026-08-19T23:15:00Z")); // 19:15 ET
    expect(etHour).toBe(19);
    expect(shouldSweepNow({ etHour, etMinute: 15 })).toBe(true);
  });
});
