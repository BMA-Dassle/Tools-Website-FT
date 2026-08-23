/**
 * Registry pins for the racesim kind (PLACEHOLDER PHASE 2026-08): the kiosk is
 * the ONLY surface with a Race Sims entry path, so the web registry's list must
 * stay empty (a non-empty web list would imply a web flow that doesn't exist)
 * and the kiosk list must keep its product → track → people order — the wizard
 * renders these ids in sequence and KioskFlow's NATIVE_STEP_IDS/title maps key
 * off them.
 */
import { describe, expect, it } from "vitest";
import { KIOSK_STEP_REGISTRY } from "./registry";
import { STEP_REGISTRY } from "~/features/booking/state/steps";

describe("racesim step registries", () => {
  it("web registry carries the key but no steps (kiosk-only flow)", () => {
    expect(STEP_REGISTRY.racesim).toEqual([]);
  });

  it("kiosk registry runs product → track → people", () => {
    expect(KIOSK_STEP_REGISTRY.racesim.map((s) => s.id)).toEqual([
      "racesim-product",
      "racesim-track",
      "kiosk-who",
    ]);
  });

  it("every kiosk racesim step is visible for a fresh draft (no hidden dead-ends)", () => {
    for (const step of KIOSK_STEP_REGISTRY.racesim) {
      expect(typeof step.isVisible).toBe("function");
      expect(typeof step.canAdvance).toBe("function");
    }
  });
});
