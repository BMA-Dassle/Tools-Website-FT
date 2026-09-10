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

/**
 * NFL Ticket on the kiosk enters from the OPPOSITE end of the flow to the web.
 *
 * The web reaches it by URL (/book/nfl), so the game picker replaces the front
 * of the wizard and is registered BEFORE the experience step. The kiosk reaches
 * it by tapping the NFL card ON the experience step (owner 2026-09-09: "include
 * it on the kiosk under experiences, that's the only spot I want it on kiosk —
 * the experience section is meant for stuff like this where it triggers the
 * time"). A picker left in the web's position would sit behind the guest: the
 * flow only walks forward and the time step is hidden for NFL, so they would
 * sail past the game pick to shoes and reserve with no gameId, which is exactly
 * the 400 guardNflBooking raises.
 */
describe("kiosk NFL step order", () => {
  const ids = () => KIOSK_STEP_REGISTRY.bowling.map((s) => s.id);

  it("puts the game picker directly after the experience step", () => {
    const order = ids();
    const exp = order.indexOf("bowling-experience");
    const game = order.indexOf("nfl-game");
    expect(exp).toBeGreaterThanOrEqual(0);
    expect(game).toBe(exp + 1);
  });

  it("keeps the picker AHEAD of the steps that finish the booking", () => {
    // The per-bowler details step (which REPLACES bowling-shoes on the kiosk)
    // and food still have to run after the game is chosen — the move must not
    // have pushed the picker past them.
    const order = ids();
    const game = order.indexOf("nfl-game");
    for (const later of ["kiosk-bowling-details", "bowling-food"]) {
      const idx = order.indexOf(later);
      if (idx >= 0) expect(game).toBeLessThan(idx);
    }
  });

  it("does not drop or duplicate any step while reordering", () => {
    const order = ids();
    expect(new Set(order).size).toBe(order.length);
    // Every web bowling step still has a home on the kiosk apart from the three
    // the registry deliberately re-shapes: contact + players fold into the
    // kiosk people step, and bowling-shoes is REPLACED by the per-bowler
    // details step (the count is derived from the size picks, owner
    // 2026-07-25). Moving a step must not have lost any of the rest.
    const RESHAPED = new Set(["contact", "bowling-players", "bowling-shoes"]);
    const web = STEP_REGISTRY.bowling.map((s) => s.id).filter((id) => !RESHAPED.has(id));
    for (const id of web) expect(order).toContain(id);
    // …and the replacements really are there, so this can never pass by simply
    // shrinking the kiosk list.
    expect(order).toContain("kiosk-bowling-people");
    expect(order).toContain("kiosk-bowling-details");
  });
});
