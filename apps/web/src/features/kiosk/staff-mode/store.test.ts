import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STAFF_IDLE_MS,
  _peekStaffMode,
  _resetStaffModeForTests,
  armStaffMode,
  closeStaffSheet,
  endStaffMode,
  openStaffSheet,
  touchStaffMode,
} from "./store";

const sam = { id: "465243", name: "Sam Ortiz", role: "Manager", cardTail: "3464" };
const maya = { memberId: "m1", personId: "15963412", name: "Maya Trepasso" };

describe("staff-mode store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetStaffModeForTests();
  });
  afterEach(() => {
    _resetStaffModeForTests();
    vi.useRealTimers();
  });

  it("arms with the employee + token and ends by itself after the idle window", () => {
    armStaffMode(sam, "tok");
    expect(_peekStaffMode().employee?.name).toBe("Sam Ortiz");
    expect(_peekStaffMode().token).toBe("tok");
    vi.advanceTimersByTime(STAFF_IDLE_MS - 1);
    expect(_peekStaffMode().employee).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(_peekStaffMode().employee).toBeNull();
    expect(_peekStaffMode().token).toBe("");
  });

  it("a touch refills the window", () => {
    armStaffMode(sam, "tok");
    vi.advanceTimersByTime(STAFF_IDLE_MS - 1_000);
    touchStaffMode();
    vi.advanceTimersByTime(STAFF_IDLE_MS - 1);
    expect(_peekStaffMode().employee).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(_peekStaffMode().employee).toBeNull();
  });

  it("an open sheet PAUSES the clock; closing it counts as a touch", () => {
    armStaffMode(sam, "tok");
    openStaffSheet({ kind: "membership", target: maya });
    vi.advanceTimersByTime(STAFF_IDLE_MS * 5);
    expect(_peekStaffMode().employee).not.toBeNull();
    expect(_peekStaffMode().sheet?.kind).toBe("membership");
    closeStaffSheet();
    vi.advanceTimersByTime(STAFF_IDLE_MS - 1);
    expect(_peekStaffMode().employee).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(_peekStaffMode().employee).toBeNull();
  });

  it("logout ends everything, including an open sheet, and is idempotent", () => {
    armStaffMode(sam, "tok");
    openStaffSheet({ kind: "comp", target: maya });
    endStaffMode();
    expect(_peekStaffMode()).toMatchObject({ employee: null, token: "", sheet: null });
    endStaffMode();
    expect(_peekStaffMode().employee).toBeNull();
  });

  it("a sheet cannot open when staff mode is off", () => {
    openStaffSheet({ kind: "history", target: maya });
    expect(_peekStaffMode().sheet).toBeNull();
  });

  it("re-arming (a second scan) refreshes the token and the clock", () => {
    armStaffMode(sam, "tok1");
    vi.advanceTimersByTime(STAFF_IDLE_MS - 500);
    armStaffMode(sam, "tok2");
    expect(_peekStaffMode().token).toBe("tok2");
    vi.advanceTimersByTime(STAFF_IDLE_MS - 1);
    expect(_peekStaffMode().employee).not.toBeNull();
  });
});
