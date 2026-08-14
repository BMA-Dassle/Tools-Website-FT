import { describe, expect, it } from "vitest";
import {
  formatRemaining,
  nextCountingState,
  parseLiveFrame,
  type CountingTracker,
  type LiveClockFrame,
} from "./live-session";

describe("nextCountingState — the two-phase start's counting verdict", () => {
  const frame = (over: Partial<LiveClockFrame>): LiveClockFrame => ({
    hasRace: true,
    heatName: "Heat 57",
    state: "running",
    remainingMs: 480_000,
    ...over,
  });
  const step = (prev: CountingTracker | null, over: Partial<LiveClockFrame>) =>
    nextCountingState(prev, frame(over));

  it("an armed heat repeating a static clock never counts", () => {
    let t = step(null, { remainingMs: 480_000 });
    t = step(t, { remainingMs: 480_000 });
    t = step(t, { remainingMs: 480_000 });
    expect(t?.counting).toBe(false);
  });

  it("counts the moment the wire's clock decreases", () => {
    let t = step(null, { remainingMs: 480_000 });
    t = step(t, { remainingMs: 479_200 });
    expect(t?.counting).toBe(true);
  });

  it("stays counting through a pause and a repeated value — sticky per heat", () => {
    let t = step(null, { remainingMs: 480_000 });
    t = step(t, { remainingMs: 479_000 });
    t = step(t, { state: "paused", remainingMs: 400_000 });
    t = step(t, { state: "paused", remainingMs: 400_000 });
    expect(t?.counting).toBe(true);
  });

  it("a new heat re-arms to not-counting", () => {
    let t = step(null, { remainingMs: 480_000 });
    t = step(t, { remainingMs: 479_000 });
    t = step(t, { heatName: "[HEAT] 58", remainingMs: 480_000 });
    expect(t?.counting).toBe(false);
  });

  it("a paused clock decreasing is not racing — only a RUNNING decrease counts", () => {
    let t = step(null, { state: "paused", remainingMs: 480_000 });
    t = step(t, { state: "paused", remainingMs: 479_000 });
    expect(t?.counting).toBe(false);
  });

  it("no race clears the tracker", () => {
    const t = step(null, { remainingMs: 480_000 });
    expect(
      nextCountingState(t, { hasRace: false, heatName: "", state: "idle", remainingMs: 0 }),
    ).toBeNull();
  });
});

describe("parseLiveFrame — the SMS-Timing wire shape, as the leaderboard reads it", () => {
  it("reads a running heat's clock", () => {
    const frame = parseLiveFrame(JSON.stringify({ N: "[HEAT] 57", S: 1, C: 272_500, D: [] }));
    expect(frame).toEqual({
      hasRace: true,
      heatName: "Heat 57",
      state: "running",
      remainingMs: 272_500,
    });
  });

  it("maps every state the wire sends", () => {
    expect(parseLiveFrame(JSON.stringify({ S: 1, C: 1 }))?.state).toBe("running");
    expect(parseLiveFrame(JSON.stringify({ S: 2, C: 1 }))?.state).toBe("paused");
    expect(parseLiveFrame(JSON.stringify({ S: 3, C: 0 }))?.state).toBe("finished");
    expect(parseLiveFrame(JSON.stringify({ S: 5, C: 0 }))?.state).toBe("finished");
    expect(parseLiveFrame(JSON.stringify({ S: 0, C: 0 }))?.state).toBe("idle");
  });

  it('"{}" means no race on this track — a designed empty, not an error', () => {
    expect(parseLiveFrame("{}")).toEqual({
      hasRace: false,
      heatName: "",
      state: "idle",
      remainingMs: 0,
    });
  });

  it("never returns a negative or non-finite clock", () => {
    expect(parseLiveFrame(JSON.stringify({ S: 1, C: -500 }))?.remainingMs).toBe(0);
    expect(parseLiveFrame(JSON.stringify({ S: 1, C: "soon" }))?.remainingMs).toBe(0);
    expect(parseLiveFrame(JSON.stringify({ S: 1 }))?.remainingMs).toBe(0);
  });

  it("is null for junk — the chip simply does not render", () => {
    expect(parseLiveFrame("not json")).toBeNull();
    expect(parseLiveFrame(12345)).toBeNull();
    expect(parseLiveFrame(undefined)).toBeNull();
  });
});

describe("formatRemaining", () => {
  it("shows mm:ss inside the hour, like the leaderboard", () => {
    expect(formatRemaining(272_500)).toBe("04:32");
    expect(formatRemaining(59_999)).toBe("00:59");
    expect(formatRemaining(0)).toBe("00:00");
  });

  it("grows to h:mm:ss past the hour", () => {
    expect(formatRemaining(3_725_000)).toBe("1:02:05");
  });

  it("clamps negatives to zero — a countdown never reads below empty", () => {
    expect(formatRemaining(-4_000)).toBe("00:00");
  });
});
