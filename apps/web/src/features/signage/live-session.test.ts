import { describe, expect, it } from "vitest";
import { formatRemaining, parseLiveFrame } from "./live-session";

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
