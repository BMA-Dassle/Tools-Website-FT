import { describe, expect, it } from "vitest";
import { staffActionEnabled, staffActionHint } from "./local-status";

describe("staff chip availability vs on-site sync", () => {
  it("Membership / Comp need a LOCAL person; Race history only needs an account", () => {
    for (const s of ["checking", "not-local", "unknown"] as const) {
      expect(staffActionEnabled("membership", true, s)).toBe(false);
      expect(staffActionEnabled("comp", true, s)).toBe(false);
      expect(staffActionEnabled("history", true, s)).toBe(true);
    }
    expect(staffActionEnabled("membership", true, "local")).toBe(true);
    expect(staffActionEnabled("comp", true, "local")).toBe(true);
  });

  it("no account disables everything, whatever the probe says", () => {
    expect(staffActionEnabled("history", false, "local")).toBe(false);
    expect(staffActionEnabled("membership", false, "local")).toBe(false);
  });

  it("hints name the reason, and there is none when the person is local", () => {
    expect(staffActionHint(false, "local")).toMatch(/Finish sign-in/);
    expect(staffActionHint(true, "checking")).toMatch(/Checking/);
    expect(staffActionHint(true, "not-local")).toMatch(/on-site server yet/);
    expect(staffActionHint(true, "unknown")).toMatch(/re-check/);
    expect(staffActionHint(true, "local")).toBeNull();
  });
});
