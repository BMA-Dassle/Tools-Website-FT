import { afterEach, describe, expect, it } from "vitest";
import { STEP_REGISTRY } from "./steps";
import { KIOSK_STEP_REGISTRY } from "~/features/kiosk/state/registry";
import { emptySession, newItem } from "./types";

// The v3 single-time-pick bowling flow coexists with the classic flow in one
// registry; exactly one set may be visible per session. A session that saw
// both (or neither) would double-ask for the time or dead-end the wizard.

const CLASSIC_IDS = ["bowling-slots", "bowling-tier", "bowling-offer"];
const V3_IDS = ["bowling-date", "bowling-experience", "bowling-time"];

function visibleBowlingIds(bowlingV3: boolean): string[] {
  const session = emptySession({
    entryBrand: "headpinz",
    context: bowlingV3 ? { bowlingV3: true } : {},
  });
  const item = newItem("bowling");
  return STEP_REGISTRY.bowling.filter((s) => s.isVisible(item, session)).map((s) => s.id);
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW;
});

describe("bowling v3 registry gating", () => {
  it("flag dark + no preview param → classic steps only", () => {
    const ids = visibleBowlingIds(false);
    for (const id of CLASSIC_IDS) expect(ids).toContain(id);
    for (const id of V3_IDS) expect(ids).not.toContain(id);
  });

  it("?bowlingV3=1 session → v3 steps only", () => {
    const ids = visibleBowlingIds(true);
    for (const id of V3_IDS) expect(ids).toContain(id);
    for (const id of CLASSIC_IDS) expect(ids).not.toContain(id);
  });

  it("env flag on → v3 steps only, even without the preview param", () => {
    process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW = "true";
    const ids = visibleBowlingIds(false);
    for (const id of V3_IDS) expect(ids).toContain(id);
    for (const id of CLASSIC_IDS) expect(ids).not.toContain(id);
  });

  it("kbf registry gates the same way", () => {
    const session = emptySession({ entryBrand: "headpinz", context: { bowlingV3: true } });
    const item = newItem("kbf");
    const ids = STEP_REGISTRY.kbf.filter((s) => s.isVisible(item, session)).map((s) => s.id);
    for (const id of V3_IDS) expect(ids).toContain(id);
    for (const id of CLASSIC_IDS) expect(ids).not.toContain(id);
  });

  it("the v3 date step hides on kiosks (today-only, stamped at creation)", () => {
    const session = emptySession({
      entryBrand: "headpinz",
      context: { bowlingV3: true, kiosk: true },
    });
    const item = newItem("bowling");
    const ids = STEP_REGISTRY.bowling.filter((s) => s.isVisible(item, session)).map((s) => s.id);
    expect(ids).not.toContain("bowling-date");
    expect(ids).toContain("bowling-experience");
    expect(ids).toContain("bowling-time");
  });

  it("kiosk registry: classic session sees the kiosk time/tier steps, never v3", () => {
    const session = emptySession({ entryBrand: "headpinz", context: { kiosk: true } });
    const item = newItem("bowling");
    const ids = KIOSK_STEP_REGISTRY.bowling
      .filter((s) => s.isVisible(item, session))
      .map((s) => s.id);
    expect(ids).toContain("bowling-slots"); // KioskBowlingTimeStep keeps the web id
    expect(ids).toContain("bowling-tier");
    expect(ids).toContain("bowling-offer");
    for (const id of V3_IDS) expect(ids).not.toContain(id);
  });

  it("kiosk registry: v3 session sees Experience+Time only — no date, no classic", () => {
    const session = emptySession({
      entryBrand: "headpinz",
      context: { kiosk: true, bowlingV3: true },
    });
    const item = newItem("bowling");
    const ids = KIOSK_STEP_REGISTRY.bowling
      .filter((s) => s.isVisible(item, session))
      .map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["kiosk-bowling-people", "bowling-experience", "bowling-time"]),
    );
    for (const id of [...CLASSIC_IDS, "bowling-date"]) expect(ids).not.toContain(id);
    // Roster details still present — and it now OWNS the shoes. The kiosk's
    // shoe-quantity step was removed (ceb4357a, 2026-07-25: the kiosk asked
    // "how many shoes" AND then per-bowler sizes, so a guest could rent 1 pair
    // and enter 4). The registry `replaceStep`s bowling-shoes with
    // KioskBowlingDetailsStep, which derives the count from the sizes.
    expect(ids).toContain("kiosk-bowling-details");
    expect(ids).not.toContain("bowling-shoes");
  });

  it("kiosk KBF registry gates the same way", () => {
    const v3 = emptySession({ entryBrand: "headpinz", context: { kiosk: true, bowlingV3: true } });
    const classic = emptySession({ entryBrand: "headpinz", context: { kiosk: true } });
    const item = newItem("kbf");
    const v3Ids = KIOSK_STEP_REGISTRY.kbf.filter((s) => s.isVisible(item, v3)).map((s) => s.id);
    const classicIds = KIOSK_STEP_REGISTRY.kbf
      .filter((s) => s.isVisible(item, classic))
      .map((s) => s.id);
    expect(v3Ids).toContain("bowling-experience");
    expect(v3Ids).toContain("bowling-time");
    expect(v3Ids).not.toContain("bowling-slots");
    expect(classicIds).toContain("bowling-slots");
    expect(classicIds).not.toContain("bowling-time");
  });
});

describe("enableBowlingV3 action (persisted-session adoption)", () => {
  it("stamps context and resets bowling/kbf cursors only", async () => {
    const { reducer } = await import("./machine");
    let s = emptySession({ entryBrand: "headpinz", context: {} });
    const bowling = newItem("bowling");
    const race = newItem("race");
    s = reducer(s, { type: "addItem", item: race });
    s = reducer(s, { type: "addItem", item: bowling });
    s = { ...s, cursors: { [race.id]: 3, [bowling.id]: 4 } };
    const out = reducer(s, { type: "enableBowlingV3" });
    expect(out.context.bowlingV3).toBe(true);
    expect(out.cursors[bowling.id]).toBe(0);
    expect(out.cursors[race.id]).toBe(3);
    // idempotent
    expect(reducer(out, { type: "enableBowlingV3" })).toBe(out);
  });
});
