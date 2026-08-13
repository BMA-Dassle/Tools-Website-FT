import { describe, expect, it } from "vitest";
import { START_HOLD_MS, startHoldRemainingMs, startHoldSeconds } from "./start-hold";

const SENT = 1_700_000_000_000;

function assigned(triggeredAtMs = SENT) {
  return { kind: "assigned" as const, triggeredAtMs };
}

describe("startHoldRemainingMs", () => {
  it("holds Start for ten seconds after the send", () => {
    expect(startHoldRemainingMs(assigned(), SENT)).toBe(START_HOLD_MS);
    expect(startHoldRemainingMs(assigned(), SENT + 1_000)).toBe(9_000);
    expect(startHoldRemainingMs(assigned(), SENT + 9_999)).toBe(1);
  });

  it("releases the moment the hold is up, and stays released", () => {
    expect(startHoldRemainingMs(assigned(), SENT + START_HOLD_MS)).toBe(0);
    expect(startHoldRemainingMs(assigned(), SENT + 60_000)).toBe(0);
    expect(startHoldRemainingMs(assigned(), SENT + 3_600_000)).toBe(0);
  });

  it("never holds a running timeline — Restart is for latecomers already seated", () => {
    expect(startHoldRemainingMs({ kind: "timeline", triggeredAtMs: SENT }, SENT)).toBe(0);
    expect(startHoldRemainingMs({ kind: "timeline", triggeredAtMs: SENT }, SENT + 1_000)).toBe(0);
  });

  it("holds nothing when there is nothing to start", () => {
    expect(startHoldRemainingMs(null, SENT)).toBe(0);
    expect(startHoldRemainingMs(undefined, SENT)).toBe(0);
  });

  it("fails open on an unusable clock rather than blocking a safety video", () => {
    expect(startHoldRemainingMs(assigned(NaN), SENT)).toBe(0);
    expect(startHoldRemainingMs(assigned(Infinity), SENT)).toBe(0);
    expect(startHoldRemainingMs(assigned(), NaN)).toBe(0);
  });

  it("clamps a desk clock running behind the server to the hold itself", () => {
    // Desk PC a full minute slow: the raw arithmetic says 70s, but the wait must
    // never exceed the skew — and the button must never count down from 70.
    expect(startHoldRemainingMs(assigned(), SENT - 60_000)).toBe(START_HOLD_MS);
    expect(startHoldRemainingMs(assigned(), SENT - 1)).toBe(START_HOLD_MS);
  });
});

describe("startHoldSeconds", () => {
  it("ceils, so a hold with milliseconds left never reads 0", () => {
    expect(startHoldSeconds(START_HOLD_MS)).toBe(10);
    expect(startHoldSeconds(9_001)).toBe(10);
    expect(startHoldSeconds(1)).toBe(1);
    expect(startHoldSeconds(0)).toBe(0);
  });
});
