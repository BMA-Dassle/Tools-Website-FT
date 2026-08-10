import { describe, expect, it } from "vitest";
import { STEP_REGISTRY, plannedStepsFor } from "./steps";
import { emptySession, newItem, newPartyMember } from "./types";
import type { BookingSession, RaceItem } from "./types";

function raceSession(): { session: BookingSession; item: RaceItem } {
  const session = emptySession({ entryBrand: "fasttrax" });
  const item = { ...newItem("race"), date: "2026-08-12" } as RaceItem;
  session.items = [item];
  session.party = [
    newPartyMember({ firstName: "A", isNewRacer: true, category: "adult" }),
    newPartyMember({ firstName: "B", isNewRacer: true, category: "adult" }),
  ];
  return { session, item };
}

describe("plannedStepsFor — the stable progress denominator", () => {
  it("a bundle pick never changes the planned step count (the 'steps change after click' bug)", () => {
    const { session, item } = raceSession();
    const before = plannedStepsFor(STEP_REGISTRY.race, item, session);
    const chosen = { ...item, packageIdAdult: "ultimate-qualifier-weekday" } as RaceItem;
    session.items = [chosen];
    const after = plannedStepsFor(STEP_REGISTRY.race, chosen, session);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it("live visible steps are always a subset of the planned list", () => {
    const { session, item } = raceSession();
    const chosen = { ...item, packageIdAdult: "ultimate-qualifier-weekday" } as RaceItem;
    session.items = [chosen];
    const planned = new Set(plannedStepsFor(STEP_REGISTRY.race, chosen, session).map((s) => s.id));
    const live = STEP_REGISTRY.race.filter((s) => s.isVisible(chosen, session)).map((s) => s.id);
    for (const id of live) expect(planned.has(id)).toBe(true);
  });

  it("non-race kinds pass through as the live visible list", () => {
    const session = emptySession({ entryBrand: "fasttrax" });
    const item = newItem("attraction");
    session.items = [item];
    const planned = plannedStepsFor(STEP_REGISTRY.attraction, item, session).map((s) => s.id);
    const live = STEP_REGISTRY.attraction
      .filter((s) => s.isVisible(item, session))
      .map((s) => s.id);
    expect(planned).toEqual(live);
  });
});
