import { afterEach, describe, expect, it } from "vitest";
import { STEP_REGISTRY } from "./steps";
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
});
