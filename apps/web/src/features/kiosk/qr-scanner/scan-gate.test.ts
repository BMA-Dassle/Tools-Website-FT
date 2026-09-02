import { beforeEach, describe, expect, it } from "vitest";
import { SCAN_COOLDOWN_MS, holdScanGate, resetScanGate, takeScanGate } from "./scan-gate";

describe("scan gate", () => {
  beforeEach(() => resetScanGate());

  it("gives the owner-asked 3-4 second window", () => {
    expect(SCAN_COOLDOWN_MS).toBeGreaterThanOrEqual(3_000);
    expect(SCAN_COOLDOWN_MS).toBeLessThanOrEqual(4_000);
  });

  it("takes the first scan and refuses the reader's repeat reads", () => {
    const t = 1_000_000;
    expect(takeScanGate(SCAN_COOLDOWN_MS, t)).toBe(true);
    // An auto-sense reader fires several times a second at the same card.
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + 100)).toBe(false);
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + 900)).toBe(false);
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS - 1)).toBe(false);
  });

  it("reopens once the cooldown has passed", () => {
    const t = 1_000_000;
    expect(takeScanGate(SCAN_COOLDOWN_MS, t)).toBe(true);
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe(true);
  });

  // THE WHOLE REASON this is module state and not a hook ref. The scan that
  // routes a guest off the chooser unmounts that listener and mounts Game
  // Zone's; per-component state would start clean and accept the reader's
  // second look at the same card as a brand-new scan.
  it("stays shut across the screen change a scan causes", () => {
    const t = 1_000_000;
    expect(takeScanGate(SCAN_COOLDOWN_MS, t)).toBe(true); // chooser routes to Game Zone
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + 250)).toBe(false); // GZ's listener mounts
  });

  it("a refused scan does not extend the cooldown", () => {
    const t = 1_000_000;
    takeScanGate(SCAN_COOLDOWN_MS, t);
    takeScanGate(SCAN_COOLDOWN_MS, t + 3_000); // refused
    // Still measured from the ACCEPTED scan, so repeats can't starve a guest
    // who is genuinely presenting a second card.
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe(true);
  });

  it("hold closes the gate without consuming a scan", () => {
    const t = 1_000_000;
    holdScanGate(SCAN_COOLDOWN_MS, t); // a screen that got its card by hand-off
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + 100)).toBe(false);
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe(true);
  });

  it("hold never shortens a cooldown already running", () => {
    const t = 1_000_000;
    takeScanGate(SCAN_COOLDOWN_MS, t);
    holdScanGate(1, t); // a shorter hold must not reopen the gate early
    expect(takeScanGate(SCAN_COOLDOWN_MS, t + 500)).toBe(false);
  });
});
