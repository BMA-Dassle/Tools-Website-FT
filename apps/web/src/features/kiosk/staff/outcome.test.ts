import { describe, it, expect } from "vitest";
import type { LoadState, TxnState } from "../../game-cards/types";
import { loadOutcome } from "./outcome";

const STATES: TxnState[] = ["started", "charged", "charge_failed", "completed", "failed"];
const LOAD_STATES: LoadState[] = ["pending", "loaded", "load_failed"];

describe("loadOutcome", () => {
  it("maps EVERY state × load_state pair to exactly one label", () => {
    for (const state of STATES) {
      for (const loadState of LOAD_STATES) {
        const o = loadOutcome({ state, loadState });
        expect(o.label).toBeTruthy();
        expect(o.detail).toBeTruthy();
      }
    }
  });

  it("loaded wins — including the stamped-loaded-but-actually-empty defect", () => {
    // The ledger cannot see the card; a `loaded` row reads Loaded. The live
    // card lookup is the tool that catches the 2026-09-01 empty-card defect.
    for (const state of STATES) {
      expect(loadOutcome({ state, loadState: "loaded" }).label).toBe("Loaded");
    }
  });

  it("guest paid but Intercard refused → Charged, not loaded (bad)", () => {
    const o = loadOutcome({ state: "charged", loadState: "load_failed" });
    expect(o.label).toBe("Charged, not loaded");
    expect(o.tone).toBe("bad");
  });

  it("guest paid, credit still pending → Charged, not loaded (warn — cron retries)", () => {
    const o = loadOutcome({ state: "charged", loadState: "pending" });
    expect(o.label).toBe("Charged, not loaded");
    expect(o.tone).toBe("warn");
  });

  it("charge never completed → Charge failed, nothing owed", () => {
    expect(loadOutcome({ state: "charge_failed", loadState: "pending" }).label).toBe(
      "Charge failed",
    );
    expect(loadOutcome({ state: "failed", loadState: "pending" }).label).toBe("Charge failed");
  });

  it("started + pending → In progress", () => {
    expect(loadOutcome({ state: "started", loadState: "pending" }).label).toBe("In progress");
  });
});
