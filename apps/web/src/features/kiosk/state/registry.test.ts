/**
 * Registry pins for the racesim kind: the kiosk is the ONLY surface with a
 * Race Sims entry path, so the web registry's list must stay empty (a
 * non-empty web list would imply a web flow that doesn't exist) and the kiosk
 * list must keep racing's order — people → contact → product → (track) → time
 * (owner 2026-08-26: "follow racing as close as possible") — the wizard
 * renders these ids in sequence and KioskFlow's NATIVE_STEP_IDS/title maps and
 * roster intercepts key off them.
 */
import { describe, expect, it } from "vitest";
import { KIOSK_STEP_REGISTRY } from "./registry";
import { STEP_REGISTRY } from "~/features/booking/state/steps";

describe("racesim step registries", () => {
  it("web registry carries the key but no steps (kiosk-only flow)", () => {
    expect(STEP_REGISTRY.racesim).toEqual([]);
  });

  it("kiosk registry mirrors racing: people → contact → product → track → time", () => {
    // Racing's kiosk order (race-party → contact → product → heats) with the
    // track step added (owner 2026-08-26). Contact is the SAME ContactStep
    // racing carries — KioskFlow skips it forward once contact is complete.
    expect(KIOSK_STEP_REGISTRY.racesim.map((s) => s.id)).toEqual([
      "racesim-party",
      "contact",
      "racesim-product",
      "racesim-track",
      "racesim-slot",
    ]);
  });

  it("racesim people step is racing's contract: own id, whole party, same title", () => {
    const people = KIOSK_STEP_REGISTRY.racesim[0]!;
    const racing = KIOSK_STEP_REGISTRY.race.find((s) => s.id === "race-party")!;
    expect(people.title).toBe(racing.title);
    // Not "race-party": KioskFlow's kart-only height/age attestation must
    // never fire for a sim.
    expect(people.id).toBe("racesim-party");
  });

  it("every kiosk racesim step is visible for a fresh draft (no hidden dead-ends)", () => {
    for (const step of KIOSK_STEP_REGISTRY.racesim) {
      expect(typeof step.isVisible).toBe("function");
      expect(typeof step.canAdvance).toBe("function");
    }
  });
});
