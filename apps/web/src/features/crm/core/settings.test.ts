import { describe, expect, it } from "vitest";
import {
  RESPONSE_TARGET_DEFAULT_MINUTES,
  SETTINGS_SEED,
  SWEEP_DEFAULT,
  isCrmSettingKey,
  responseTargetFromSetting,
  settingsFromRows,
  sweepFromSetting,
} from "./settings";

/** Every decoder fails OPEN to its default — and `bmi_writes` to ON (R4). */

describe("settings decoders", () => {
  it("no rows at all = every default, with BMI writes ENABLED", () => {
    expect(settingsFromRows([])).toEqual({
      bmiWrites: { enabled: true, offCentres: [] },
      sweep: { delayMinutes: 60, afterHours: "hold9am" },
      responseTargetMinutes: 60,
    });
  });

  it("a stored pause is honoured; garbage in the row is the default, never 'off'", () => {
    expect(
      settingsFromRows([
        { key: "bmi_writes", value: { enabled: false, offCentres: ["headpinznaples"] } },
      ]).bmiWrites,
    ).toEqual({ enabled: false, offCentres: ["headpinznaples"] });
    expect(settingsFromRows([{ key: "bmi_writes", value: "nope" }]).bmiWrites.enabled).toBe(true);
    expect(settingsFromRows([{ key: "bmi_writes", value: null }]).bmiWrites.enabled).toBe(true);
  });

  it("sweep: per-field fallback", () => {
    expect(sweepFromSetting(undefined)).toEqual(SWEEP_DEFAULT);
    expect(sweepFromSetting({ delayMinutes: 30 })).toEqual({
      delayMinutes: 30,
      afterHours: "hold9am",
    });
    expect(sweepFromSetting({ afterHours: "assign" })).toEqual({
      delayMinutes: 60,
      afterHours: "assign",
    });
    expect(sweepFromSetting({ delayMinutes: -5, afterHours: "later" })).toEqual(SWEEP_DEFAULT);
    expect(sweepFromSetting({ delayMinutes: 12.6 })).toEqual({
      delayMinutes: 13,
      afterHours: "hold9am",
    });
  });

  it("response target: positive integer minutes, else the default", () => {
    expect(responseTargetFromSetting(45)).toBe(45);
    expect(responseTargetFromSetting("90")).toBe(90);
    expect(responseTargetFromSetting(0)).toBe(RESPONSE_TARGET_DEFAULT_MINUTES);
    expect(responseTargetFromSetting("x")).toBe(RESPONSE_TARGET_DEFAULT_MINUTES);
    expect(responseTargetFromSetting(undefined)).toBe(RESPONSE_TARGET_DEFAULT_MINUTES);
  });

  it("the seed stores the defaults explicitly and the key guard knows the three keys", () => {
    expect(SETTINGS_SEED.map((s) => s.key)).toEqual([
      "bmi_writes",
      "sweep",
      "response_target_minutes",
    ]);
    expect(settingsFromRows(SETTINGS_SEED)).toEqual(settingsFromRows([]));
    expect(isCrmSettingKey("bmi_writes")).toBe(true);
    expect(isCrmSettingKey("nope")).toBe(false);
  });
});
