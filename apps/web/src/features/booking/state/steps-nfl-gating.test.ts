import { afterEach, describe, expect, it } from "vitest";
import { STEP_REGISTRY } from "./steps";
import { emptySession, newItem } from "./types";
import type { BookingSession, SessionItem } from "./types";

/**
 * NFL Ticket has its OWN entry (?experience=nfl) — it is not a card inside the
 * bowling wizard.
 *
 * The first cut shipped it the wrong way round (2026-08-31): the gating keyed
 * on `experienceSlug.startsWith("nfl-vip-")`, and a slug is only known AFTER a
 * game is picked, so it could not hide the steps that run BEFORE the picker.
 * The guest was walked through Date and Experience to reach a card, then handed
 * a game picker that overrode both answers. Owner, 2026-09-01: "I do not want
 * this in the regular bowling booking flow this was supposed to be outside of
 * it like soccer was."
 *
 * These tests pin the corrected shape: the marker is on the ITEM, and it hides
 * the whole front of BOTH step families.
 */

const CLASSIC_IDS = ["bowling-slots", "bowling-tier", "bowling-offer"];
const V3_IDS = ["bowling-date", "bowling-experience", "bowling-time"];
const NFL_ID = "nfl-game";

function bowlingItem(over: Partial<Record<string, unknown>> = {}): SessionItem {
  return Object.assign(newItem("bowling"), over);
}

function visibleIds(item: SessionItem, session?: BookingSession): string[] {
  const s = session ?? emptySession({ entryBrand: "headpinz" });
  return STEP_REGISTRY.bowling.filter((step) => step.isVisible(item, s)).map((step) => step.id);
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW;
});

describe("NFL step gating", () => {
  it("a plain bowling item never sees the game picker", () => {
    const ids = visibleIds(bowlingItem());
    expect(ids).not.toContain(NFL_ID);
    for (const id of V3_IDS) expect(ids).toContain(id);
  });

  it("an NFL item replaces the ENTIRE v3 front — date, experience AND time", () => {
    // The regression: previously only `bowling-time` was hidden, so the guest
    // answered Date and Experience before reaching a picker that overrode both.
    const ids = visibleIds(bowlingItem({ isNfl: true }));
    expect(ids).toContain(NFL_ID);
    for (const id of V3_IDS) expect(ids).not.toContain(id);
  });

  it("an NFL item replaces the classic front too, when the kill switch is thrown", () => {
    // NflGameStep is deliberately NOT wrapped in v3Only — like the World Cup
    // picker it stands on its own, so a flow-flag change can never strand an
    // NFL session with no way to pick a game.
    process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW = "false";
    const ids = visibleIds(bowlingItem({ isNfl: true }));
    expect(ids).toContain(NFL_ID);
    for (const id of CLASSIC_IDS) expect(ids).not.toContain(id);
    for (const id of V3_IDS) expect(ids).not.toContain(id);
  });

  it("leaves the rest of the wizard intact — the booking still has to complete", () => {
    // Hiding the front must not hide the steps that collect who is coming and
    // what shoes they need; an NFL booking is still a bowling booking.
    const ids = visibleIds(bowlingItem({ isNfl: true }));
    expect(ids).toContain("contact");
    expect(ids).toContain("bowling-players");
    expect(ids).toContain("bowling-shoes");
  });

  it("the picker keys on the item marker, NOT on the experience slug", () => {
    // A slug alone must not summon the step: that is the ordering bug. And an
    // NFL item must show the picker BEFORE any slug exists, which is the whole
    // point — the picker is what assigns the slug.
    expect(visibleIds(bowlingItem({ experienceSlug: "nfl-vip-fri-sun" }))).not.toContain(NFL_ID);
    expect(visibleIds(bowlingItem({ isNfl: true, experienceSlug: null }))).toContain(NFL_ID);
  });

  it("does not collide with the World Cup entry", () => {
    const wc = visibleIds(bowlingItem({ isWorldCup: true }));
    expect(wc).toContain("world-cup-match");
    expect(wc).not.toContain(NFL_ID);

    const nfl = visibleIds(bowlingItem({ isNfl: true }));
    expect(nfl).toContain(NFL_ID);
    expect(nfl).not.toContain("world-cup-match");
  });
});
