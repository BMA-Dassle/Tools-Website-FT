import { beforeEach, describe, expect, it } from "vitest";
import { SCAN_COOLDOWN_MS, holdScanGate, resetScanGate, takeScanGate } from "./scan-gate";

/** The payloads a real reader hands over — a padded card barcode and a voucher. */
const CARD = "0000000001063464";
const OTHER_CARD = "0000000001038115";
const VOUCHER = "HPWZ96RZ4SX";

describe("scan gate", () => {
  beforeEach(() => resetScanGate());

  it("gives the owner-asked 3-4 second window", () => {
    expect(SCAN_COOLDOWN_MS).toBeGreaterThanOrEqual(3_000);
    expect(SCAN_COOLDOWN_MS).toBeLessThanOrEqual(4_000);
  });

  it("takes the first scan and refuses what follows inside the window", () => {
    const t = 1_000_000;
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t)).toBe("ok");
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + 100)).not.toBe("ok");
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS - 1)).not.toBe("ok");
  });

  it("reopens once the cooldown has passed", () => {
    const t = 1_000_000;
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t)).toBe("ok");
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe("ok");
  });

  // THE WHOLE REASON this is module state and not a hook ref. The scan that
  // routes a guest off the chooser unmounts that listener and mounts Game
  // Zone's; per-component state would start clean and accept the reader's
  // second look at the same card as a brand-new scan.
  it("stays shut across the screen change a scan causes", () => {
    const t = 1_000_000;
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t)).toBe("ok"); // chooser routes to Game Zone
    expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + 250)).not.toBe("ok"); // GZ's listener mounts
  });

  it("a refused scan does not extend the cooldown", () => {
    const t = 1_000_000;
    takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
    takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + 3_000); // refused
    // Still measured from the ACCEPTED scan, so repeats can't starve a guest
    // who is genuinely presenting a second card.
    expect(takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe("ok");
  });

  it("hold closes the gate without consuming a scan", () => {
    const t = 1_000_000;
    holdScanGate(SCAN_COOLDOWN_MS, t); // a screen that got its card by hand-off
    expect(takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + 100)).not.toBe("ok");
    expect(takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe("ok");
  });

  it("hold never shortens a cooldown already running", () => {
    const t = 1_000_000;
    takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
    holdScanGate(1, t); // a shorter hold must not reopen the gate early
    expect(takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + 500)).not.toBe("ok");
  });

  // What decides whether the guest hears the negative tone (owner 2026-09-02).
  describe("telling a reader's repeat apart from the guest scanning again", () => {
    it("calls the SAME payload a repeat, so it can be dropped in silence", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + 120)).toBe("repeat");
    });

    it("calls a DIFFERENT payload a cooldown, so the guest is told to wait", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      expect(takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + 120)).toBe("cooldown");
      expect(takeScanGate(VOUCHER, SCAN_COOLDOWN_MS, t + 200)).toBe("cooldown");
    });

    // The audible bug this prevents: one physical scan on the chooser routes to
    // Game Zone (accept tone), the reader looks at the same card again 200ms
    // later, and the new listener would sound a REJECT over the top of it.
    it("keeps the hand-off quiet — hold preserves the accepted payload", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t); // entry screen accepts, routes
      holdScanGate(SCAN_COOLDOWN_MS, t + 200); // Game Zone seeds from the hand-off
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + 260)).toBe("repeat");
    });

    it("cannot tell them apart with no payload, and says cooldown", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      expect(takeScanGate(undefined, SCAN_COOLDOWN_MS, t + 120)).toBe("cooldown");
    });

    it("does not treat a repeat AFTER the window as anything but a fresh scan", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      // Same card, but the guest deliberately re-presented it later — that is a
      // real scan and must be acted on, not swallowed as a reader echo.
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe("ok");
    });
  });
});
