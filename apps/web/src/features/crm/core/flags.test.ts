import { afterEach, describe, expect, it } from "vitest";
import {
  BMI_WRITES_DEFAULT,
  CRM_FLAG_ENV,
  bmiWritesAllowedFor,
  bmiWritesFromSetting,
  crmAutoAssignEnabled,
  crmBmiWritesEnabled,
  crmBmiWritesOffCentres,
  crmCallsEnabled,
  crmEmailEnabled,
  crmSmsEnabled,
} from "./flags";

afterEach(() => {
  for (const k of CRM_FLAG_ENV) delete process.env[k];
});

const BOOLEAN_SWITCHES: [string, () => boolean][] = [
  ["CRM_BMI_WRITES", crmBmiWritesEnabled],
  ["CRM_SMS", crmSmsEnabled],
  ["CRM_EMAIL", crmEmailEnabled],
  ["CRM_CALLS", crmCallsEnabled],
  ["CRM_AUTO_ASSIGN", crmAutoAssignEnabled],
];

describe('the env switches are kill switches: ON unless exactly "false"', () => {
  it("names six env vars", () => {
    expect([...CRM_FLAG_ENV]).toEqual([
      "CRM_BMI_WRITES",
      "CRM_BMI_WRITES_OFF_CENTRES",
      "CRM_SMS",
      "CRM_EMAIL",
      "CRM_CALLS",
      "CRM_AUTO_ASSIGN",
    ]);
  });

  for (const [name, fn] of BOOLEAN_SWITCHES) {
    it(`${name}: unset → on, "true" → on, "0" → on, "false" → off`, () => {
      delete process.env[name];
      expect(fn()).toBe(true);
      process.env[name] = "true";
      expect(fn()).toBe(true);
      process.env[name] = "0";
      expect(fn()).toBe(true);
      process.env[name] = "";
      expect(fn()).toBe(true);
      process.env[name] = "false";
      expect(fn()).toBe(false);
    });
  }

  it("CRM_BMI_WRITES_OFF_CENTRES: unset → nothing paused; a comma list → those keys", () => {
    expect(crmBmiWritesOffCentres().size).toBe(0);
    process.env.CRM_BMI_WRITES_OFF_CENTRES = " headpinznaples , ,headpinzftmyers";
    expect([...crmBmiWritesOffCentres()].sort()).toEqual(["headpinzftmyers", "headpinznaples"]);
  });
});

describe("bmiWritesFromSetting — no row = ON (brief R4)", () => {
  it("decodes null / undefined / garbage to the enabled default", () => {
    for (const v of [null, undefined, "", "off", 0, false, [], ["x"], 42]) {
      expect(bmiWritesFromSetting(v)).toEqual({ enabled: true, offCentres: [] });
    }
    expect(BMI_WRITES_DEFAULT).toEqual({ enabled: true, offCentres: [] });
  });

  it("treats a row with the wrong field types as enabled", () => {
    expect(bmiWritesFromSetting({ enabled: "false", offCentres: "headpinznaples" })).toEqual({
      enabled: true,
      offCentres: [],
    });
    expect(bmiWritesFromSetting({})).toEqual({ enabled: true, offCentres: [] });
  });

  it("honours an explicit pause", () => {
    expect(bmiWritesFromSetting({ enabled: false })).toEqual({ enabled: false, offCentres: [] });
    expect(bmiWritesFromSetting({ enabled: true, offCentres: ["headpinznaples", 3, ""] })).toEqual({
      enabled: true,
      offCentres: ["headpinznaples"],
    });
  });

  it("returns a fresh object every time — callers may mutate it", () => {
    const a = bmiWritesFromSetting(null);
    a.offCentres.push("x");
    expect(bmiWritesFromSetting(null).offCentres).toEqual([]);
  });
});

describe("bmiWritesAllowedFor combines env and setting", () => {
  it("is allowed with nothing set anywhere", () => {
    expect(bmiWritesAllowedFor("headpinzftmyers", null)).toBe(true);
  });

  it("is refused by the env master switch", () => {
    process.env.CRM_BMI_WRITES = "false";
    expect(bmiWritesAllowedFor("headpinzftmyers", null)).toBe(false);
  });

  it("is refused for a tenant named in either pause list, and allowed for the other", () => {
    process.env.CRM_BMI_WRITES_OFF_CENTRES = "headpinznaples";
    expect(bmiWritesAllowedFor("headpinznaples", null)).toBe(false);
    expect(bmiWritesAllowedFor("headpinzftmyers", null)).toBe(true);
    delete process.env.CRM_BMI_WRITES_OFF_CENTRES;
    expect(bmiWritesAllowedFor("headpinzftmyers", { offCentres: ["headpinzftmyers"] })).toBe(false);
    expect(bmiWritesAllowedFor("headpinznaples", { offCentres: ["headpinzftmyers"] })).toBe(true);
  });

  it("is refused by the director's toggle", () => {
    expect(bmiWritesAllowedFor("headpinzftmyers", { enabled: false })).toBe(false);
  });
});
