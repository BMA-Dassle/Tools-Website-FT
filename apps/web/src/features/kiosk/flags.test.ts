/**
 * Race Sims kiosk door — WHICH kiosks show the tile.
 *
 * Owner 2026-09-01: "SIMS need to show on the kiosk at headpinz fort myers."
 * The sims sit in the FastTrax building, but HeadPinz FM is the same complex
 * serving the same guests, so the door is keyed on the CENTER and not the
 * brand. Naples is a different building and must stay out — that exclusion is
 * the whole reason this rule is a named function instead of an inline boolean.
 *
 * Device ids below are the real fleet (kiosk_devices, probed 2026-09-01).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  kioskRaceSimDoorOpen,
  kioskRaceSimEnabled,
  kioskRaceSimsLive,
  kioskTodaysCrewEnabled,
} from "./flags";

const ORIGINAL = process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS;
  else process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS = ORIGINAL;
});

describe("kioskRaceSimsLive — OPT-IN gate, defaults LOCKED", () => {
  const ORIGINAL_LIVE = process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE;
  afterEach(() => {
    if (ORIGINAL_LIVE === undefined) delete process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE;
    else process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE = ORIGINAL_LIVE;
  });

  it("is LOCKED when unset — the opposite default to every kill switch here", () => {
    // Deliberate inversion of the house rule (owner 2026-09-15): the sim flow
    // is finished but has never been smoked against a real guest booking, so
    // an unset env must leave guests on "Coming Soon" behind the staff PIN.
    delete process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE;
    expect(kioskRaceSimsLive()).toBe(false);
  });

  it('opens ONLY on the exact string "true"', () => {
    // Anything else — "1", "yes", "TRUE", a stray space — stays locked, so a
    // fat-fingered Vercel value cannot put an unsmoked flow in front of guests.
    for (const v of ["1", "yes", "TRUE", "True", " true", "", "false"]) {
      process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE = v;
      expect(kioskRaceSimsLive(), `value ${JSON.stringify(v)}`).toBe(false);
    }
    process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE = "true";
    expect(kioskRaceSimsLive()).toBe(true);
  });

  it("is independent of the kill switch — going live cannot resurrect a pulled tile", () => {
    process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS_LIVE = "true";
    process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS = "false";
    expect(kioskRaceSimsLive()).toBe(true);
    expect(kioskRaceSimDoorOpen("fort-myers")).toBe(false);
  });
});

describe("kioskTodaysCrewEnabled — kill switch, defaults ON", () => {
  const ORIGINAL_CREW = process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW;
  afterEach(() => {
    if (ORIGINAL_CREW === undefined) delete process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW;
    else process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW = ORIGINAL_CREW;
  });

  it("is ON when the variable is unset — a merged feature is on", () => {
    delete process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW;
    expect(kioskTodaysCrewEnabled()).toBe(true);
  });

  it('is OFF only on the literal "false"', () => {
    process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW = "false";
    expect(kioskTodaysCrewEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW = "FALSE";
    expect(kioskTodaysCrewEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_KIOSK_TODAYS_CREW = "0";
    expect(kioskTodaysCrewEnabled()).toBe(true);
  });
});

describe("kioskRaceSimDoorOpen — venue rule", () => {
  it("opens on BOTH brands at Fort Myers (FT:* and the nine HPFM:* units)", () => {
    // The brand is deliberately not an input: passing only the center is the
    // point. A HeadPinz FM kiosk and a FastTrax FM kiosk get the same answer.
    expect(kioskRaceSimDoorOpen("fort-myers")).toBe(true);
  });

  it("stays SHUT at Naples — different building, not just a different brand", () => {
    expect(kioskRaceSimDoorOpen("naples")).toBe(false);
  });

  it("stays shut for an unknown, missing or empty center", () => {
    expect(kioskRaceSimDoorOpen(null)).toBe(false);
    expect(kioskRaceSimDoorOpen(undefined)).toBe(false);
    expect(kioskRaceSimDoorOpen("")).toBe(false);
    expect(kioskRaceSimDoorOpen("fort myers")).toBe(false); // not the slug
  });

  it('the kill switch shuts Fort Myers too — literal "false", nothing else', () => {
    process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS = "false";
    expect(kioskRaceSimEnabled()).toBe(false);
    expect(kioskRaceSimDoorOpen("fort-myers")).toBe(false);

    // Kill switches default ON (house rule): anything that is not the literal
    // "false" leaves the door open, so a typo can never dark-ship the tile.
    process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS = "FALSE";
    expect(kioskRaceSimDoorOpen("fort-myers")).toBe(true);
    delete process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS;
    expect(kioskRaceSimDoorOpen("fort-myers")).toBe(true);
  });

  it("never opens Naples, even with the switch explicitly on", () => {
    process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS = "true";
    expect(kioskRaceSimDoorOpen("naples")).toBe(false);
  });
});
