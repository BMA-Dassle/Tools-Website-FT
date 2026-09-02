import { beforeEach, describe, expect, it } from "vitest";
import {
  SCAN_COOLDOWN_MS,
  SCAN_ECHO_MS,
  holdScanGate,
  peekScanGate,
  resetScanGate,
  takeScanGate,
} from "./scan-gate";

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

    // THE REPORT (owner 2026-09-02: "doesn't seem to work … should do negative
    // noise"). Payload-only matching made a deliberate re-scan of the same card
    // silent for the whole 3.5s, which is exactly how anyone tests this.
    it("a deliberate re-scan of the same card AFTER the echo window buzzes", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + SCAN_ECHO_MS + 1)).toBe("cooldown");
    });

    // ...but a guest who simply HOLDS the card under the beam produces an
    // unbroken stream of the same payload, and must not be buzzed at for it.
    // The window slides on every sighting, so the stream stays silent however
    // long they hold — this is what makes the test above safe.
    it("stays silent for a held card, however long it is held", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      // The reader re-fires every 300ms for three seconds.
      for (let dt = 300; dt <= 3_000; dt += 300) {
        expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + dt)).toBe("repeat");
      }
    });

    it("a gap wider than the window ends the stream — the next one buzzes", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + 300)).toBe("repeat"); // held
      // Card taken away, then presented again — a second act.
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t + 300 + SCAN_ECHO_MS + 1)).toBe("cooldown");
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

  // The entry router refuses re-entry while it is still routing the previous
  // scan — a card scan spends two network round trips in there. It has to be
  // able to ask what the guest should HEAR without shortening the cooldown of
  // the scan it is busy with; that silent early return was most of the report.
  describe("peek — a verdict without consuming the gate", () => {
    it("agrees with take about what a refused scan is", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      expect(peekScanGate(OTHER_CARD, t + 200)).toBe("cooldown");
      expect(peekScanGate(CARD, t + 200)).toBe("repeat");
    });

    it("does not shut the gate, so the routing scan keeps its full window", () => {
      const t = 1_000_000;
      expect(peekScanGate(CARD, t)).toBe("ok"); // open, and still open after
      expect(takeScanGate(CARD, SCAN_COOLDOWN_MS, t)).toBe("ok");
    });

    it("does not extend the cooldown it reports on", () => {
      const t = 1_000_000;
      takeScanGate(CARD, SCAN_COOLDOWN_MS, t);
      // Peeked at repeatedly while routing — the window must still expire on
      // schedule, measured from the accepted scan.
      for (let dt = 100; dt < SCAN_COOLDOWN_MS; dt += 100) peekScanGate(OTHER_CARD, t + dt);
      expect(takeScanGate(OTHER_CARD, SCAN_COOLDOWN_MS, t + SCAN_COOLDOWN_MS)).toBe("ok");
    });
  });
});
