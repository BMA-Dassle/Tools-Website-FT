import { afterEach, describe, expect, it } from "vitest";
import { STEP_REGISTRY } from "./steps";
import { KIOSK_STEP_REGISTRY } from "~/features/kiosk/state/registry";
import { emptySession, newItem } from "./types";

// The v3 single-time-pick bowling flow coexists with the classic flow in one
// registry; exactly one set may be visible per session. A session that saw
// both (or neither) would double-ask for the time or dead-end the wizard.
//
// v3 is now the DEFAULT (kill switch, 2026-08-25): absence of
// NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW means v3, and only the literal "false"
// falls back to classic. These tests used to read "flag dark → classic", which
// was the opt-in-gate era; they now set the kill switch explicitly to reach the
// classic flow. The `?bowlingV3=1` context flag can still force v3 ON even with
// the switch thrown, which is why the mixed classic/v3 assertions below still
// work inside a single `="false"` block.

/** Throw the kill switch for one test; afterEach clears it. */
function killSwitchOff(): void {
  process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW = "false";
}

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
  it("no env var, no preview param → V3 steps (the merged flow is the default)", () => {
    delete process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW;
    const ids = visibleBowlingIds(false);
    for (const id of V3_IDS) expect(ids).toContain(id);
    for (const id of CLASSIC_IDS) expect(ids).not.toContain(id);
  });

  it("kill switch thrown → classic steps only", () => {
    killSwitchOff();
    const ids = visibleBowlingIds(false);
    for (const id of CLASSIC_IDS) expect(ids).toContain(id);
    for (const id of V3_IDS) expect(ids).not.toContain(id);
  });

  it("exactly one flow is visible in every env state — never both, never neither", () => {
    for (const value of [undefined, "false", "true", "", "FALSE"]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW;
      else process.env.NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW = value;
      for (const preview of [false, true]) {
        const ids = visibleBowlingIds(preview);
        const classicSeen = CLASSIC_IDS.filter((id) => ids.includes(id)).length;
        const v3Seen = V3_IDS.filter((id) => ids.includes(id)).length;
        const label = `env=${String(value)} preview=${preview}`;
        // One full set, and only one.
        expect([classicSeen, v3Seen].sort(), label).toEqual([0, 3]);
      }
    }
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
    killSwitchOff();
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
    // Switch thrown so the flag-less session is classic; the other session
    // still reaches v3 through the preview flag, which only forces ON.
    killSwitchOff();
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
