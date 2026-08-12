import { describe, expect, it } from "vitest";
import {
  CHECKIN_WARN_LEAD_MS,
  WAITING_LATE_MS,
  WAITING_WARN_MS,
  checkinAlert,
  waitingAlert,
} from "./desk-alerts";

describe("waitingAlert", () => {
  it("is quiet for the first three minutes", () => {
    expect(waitingAlert(0)).toBe("none");
    expect(waitingAlert(2 * 60_000)).toBe("none");
    // Exactly three minutes is not yet PAST three minutes.
    expect(waitingAlert(WAITING_WARN_MS)).toBe("none");
  });

  it("warns past three minutes", () => {
    expect(waitingAlert(WAITING_WARN_MS + 1)).toBe("warn");
    expect(waitingAlert(4 * 60_000)).toBe("warn");
    expect(waitingAlert(WAITING_LATE_MS)).toBe("warn");
  });

  it("escalates past five minutes, and never de-escalates", () => {
    expect(waitingAlert(WAITING_LATE_MS + 1)).toBe("late");
    expect(waitingAlert(20 * 60_000)).toBe("late");
    expect(waitingAlert(3 * 3600_000)).toBe("late");
  });

  it("says nothing about an unusable timer", () => {
    expect(waitingAlert(NaN)).toBe("none");
  });
});

describe("checkinAlert", () => {
  const MIN = 60_000;

  it("is quiet while there is more than a minute left", () => {
    expect(checkinAlert(0, 8)).toBe("none");
    expect(checkinAlert(6 * MIN, 8)).toBe("none");
    // 6:59 elapsed of 8 minutes — 1:01 left.
    expect(checkinAlert(8 * MIN - CHECKIN_WARN_LEAD_MS - 1_000, 8)).toBe("none");
  });

  it("warns through the last minute of the window", () => {
    expect(checkinAlert(8 * MIN - CHECKIN_WARN_LEAD_MS, 8)).toBe("warn");
    expect(checkinAlert(7 * MIN + 30_000, 8)).toBe("warn");
    expect(checkinAlert(8 * MIN - 1, 8)).toBe("warn");
  });

  it("goes late the moment the window closes, and stays late", () => {
    expect(checkinAlert(8 * MIN, 8)).toBe("late");
    expect(checkinAlert(8 * MIN + 1, 8)).toBe("late");
    expect(checkinAlert(25 * MIN, 8)).toBe("late");
  });

  it("follows the configured window, not a hard-coded eight minutes", () => {
    // A 5-minute window warns at 4:00 and is late at 5:00.
    expect(checkinAlert(3 * MIN, 5)).toBe("none");
    expect(checkinAlert(4 * MIN, 5)).toBe("warn");
    expect(checkinAlert(5 * MIN, 5)).toBe("late");
    // A 12-minute window is still quiet where an 8-minute one would be late.
    expect(checkinAlert(8 * MIN, 12)).toBe("none");
  });

  it("raises nothing when there is no usable window", () => {
    expect(checkinAlert(30 * MIN, 0)).toBe("none");
    expect(checkinAlert(30 * MIN, -8)).toBe("none");
    expect(checkinAlert(30 * MIN, NaN)).toBe("none");
    expect(checkinAlert(NaN, 8)).toBe("none");
  });
});
