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
import { kioskRaceSimDoorOpen, kioskRaceSimEnabled } from "./flags";

const ORIGINAL = process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS;
  else process.env.NEXT_PUBLIC_KIOSK_RACE_SIMS = ORIGINAL;
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
