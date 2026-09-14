import { describe, expect, it } from "vitest";
import { pullTriggers } from "./ready-to-pull";

const MIN = 60_000;

describe("pullTriggers", () => {
  it("nothing fires on a half-checked-in grid inside the window with no press", () => {
    expect(
      pullTriggers({
        checkedIn: { checkedIn: 5, total: 8 },
        calledForMs: 3 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual([]);
  });

  it("all-in: everyone on the roster has scanned", () => {
    expect(
      pullTriggers({
        checkedIn: { checkedIn: 8, total: 8 },
        calledForMs: 2 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual(["all-in"]);
  });

  it("all-in never fires on a roster we could not read (0 of 0)", () => {
    expect(
      pullTriggers({
        checkedIn: { checkedIn: 0, total: 0 },
        calledForMs: 2 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual([]);
    expect(
      pullTriggers({
        checkedIn: null,
        calledForMs: 2 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual([]);
  });

  it("window: fires once the check-in window has RUN OUT, not during the one-minute lead", () => {
    const short = { checkedIn: 5, total: 8 };
    // 7:30 in — the desk is being warned, the wall is not yet lit.
    expect(
      pullTriggers({
        checkedIn: short,
        calledForMs: 7.5 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual([]);
    // 8:00 exactly — the time they were ever going to get is gone.
    expect(
      pullTriggers({
        checkedIn: short,
        calledForMs: 8 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual(["window"]);
    expect(
      pullTriggers({
        checkedIn: short,
        calledForMs: 11 * MIN,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual(["window"]);
  });

  it("window needs a real window and a real clock", () => {
    const short = { checkedIn: 5, total: 8 };
    expect(
      pullTriggers({
        checkedIn: short,
        calledForMs: 30 * MIN,
        checkinWindowMins: 0,
        staffReady: false,
      }),
    ).toEqual([]);
    expect(
      pullTriggers({
        checkedIn: short,
        calledForMs: null,
        checkinWindowMins: 8,
        staffReady: false,
      }),
    ).toEqual([]);
  });

  it("staff: a press is enough on its own, whatever the grid and the clock say", () => {
    expect(
      pullTriggers({
        checkedIn: { checkedIn: 2, total: 8 },
        calledForMs: 1 * MIN,
        checkinWindowMins: 8,
        staffReady: true,
      }),
    ).toEqual(["staff"]);
  });

  it("lists every trigger that fired, in the owner's order", () => {
    expect(
      pullTriggers({
        checkedIn: { checkedIn: 8, total: 8 },
        calledForMs: 9 * MIN,
        checkinWindowMins: 8,
        staffReady: true,
      }),
    ).toEqual(["all-in", "window", "staff"]);
  });
});
