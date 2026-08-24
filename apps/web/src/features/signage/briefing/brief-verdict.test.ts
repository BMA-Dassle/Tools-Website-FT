import { describe, expect, it } from "vitest";
import { briefVerdict, type BriefVerdictInput } from "./brief-verdict";
import type { SendWindow } from "./pull-to-room";

/**
 * The bug this module exists to kill: a TV wall printing BRIEF NOW over a
 * half-checked-in grid, advising the press the desk button and the room tablet
 * would refuse. Everything here is about the order the three rules resolve in.
 */

const M = 60_000;
const mmss = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const OPEN: SendWindow = { kind: "open", remainingMs: 6 * M, closesInMs: M };
const EARLY: SendWindow = { kind: "early", standMs: 4 * M, opensInMs: 2 * M };
const GRACE: SendWindow = {
  kind: "grace",
  remainingMs: 4.6 * M,
  graceLeftMs: 48_000,
  overBy: 12_000,
};
const BLOCKED: SendWindow = {
  kind: "blocked",
  why: "film",
  heatNumber: 34,
  remainingMs: 3 * M,
  postEndsInMs: null,
};

const BASE: BriefVerdictInput = {
  called: true,
  window: OPEN,
  checkedIn: { checkedIn: 5, total: 5 },
  calledForMs: 2 * M,
  checkinWindowMins: 7,
  formatClock: mmss,
};

describe("briefVerdict", () => {
  it("says nothing at all with no heat called", () => {
    expect(briefVerdict({ ...BASE, called: false })).toMatchObject({ kind: "quiet", act: false });
  });

  it("is READY only when the grid is complete and the film fits", () => {
    expect(briefVerdict(BASE)).toMatchObject({
      kind: "ready",
      phrase: "brief now",
      tone: "good",
      act: true,
    });
  });

  /** THE REPORTED BUG (owner 2026-08-24). */
  it("NEVER says brief now while the grid is short and there is still time", () => {
    const v = briefVerdict({ ...BASE, checkedIn: { checkedIn: 2, total: 5 } });
    expect(v.kind).toBe("waiting");
    expect(v.phrase).toBe("waiting on 3 racers");
    expect(v.act).toBe(false);
  });

  it("counts one missing racer in the singular", () => {
    expect(briefVerdict({ ...BASE, checkedIn: { checkedIn: 4, total: 5 } }).phrase).toBe(
      "waiting on 1 racer",
    );
  });

  it("flips to PULL TO BRIEFING NOW once the check-in window is running out", () => {
    // 7-minute window, called 6:10 ago ⇒ inside the last minute.
    const v = briefVerdict({
      ...BASE,
      checkedIn: { checkedIn: 2, total: 5 },
      calledForMs: 6 * M + 10_000,
    });
    expect(v).toMatchObject({ kind: "pull-now", phrase: "pull to briefing now", act: true });
  });

  it("stays flipped once the window has passed entirely", () => {
    expect(
      briefVerdict({
        ...BASE,
        checkedIn: { checkedIn: 2, total: 5 },
        calledForMs: 9 * M,
      }).kind,
    ).toBe("pull-now");
  });

  it("never flips when the venue has no check-in window configured", () => {
    expect(
      briefVerdict({
        ...BASE,
        checkedIn: { checkedIn: 2, total: 5 },
        calledForMs: 40 * M,
        checkinWindowMins: 0,
      }).kind,
    ).toBe("waiting");
  });

  it("cannot flip without a call stamp — an unknown age is not a deadline", () => {
    expect(
      briefVerdict({ ...BASE, checkedIn: { checkedIn: 2, total: 5 }, calledForMs: null }).kind,
    ).toBe("waiting");
  });

  /** TIME BEATS ROSTER — the precedence that keeps the advice honest. */
  it("says no time to brief even with the window up and the grid short", () => {
    const v = briefVerdict({
      ...BASE,
      window: BLOCKED,
      checkedIn: { checkedIn: 2, total: 5 },
      calledForMs: 9 * M,
    });
    expect(v).toMatchObject({ kind: "blocked", act: false });
    expect(v.phrase).toBe("no time to brief · after the post");
  });

  it("counts the grace down rather than inviting a press", () => {
    const v = briefVerdict({ ...BASE, window: GRACE });
    expect(v).toMatchObject({ kind: "grace", act: false });
    expect(v.phrase).toBe("no time to brief · 0:48 grace");
  });

  it("counts down to the window opening when the grid is already in", () => {
    expect(briefVerdict({ ...BASE, window: EARLY })).toMatchObject({
      kind: "early",
      phrase: "brief in 2:00",
      act: false,
    });
  });

  it("treats 0 of 0 as an unread roster, never as an empty grid", () => {
    // Unread must not read as "everybody is here" — but it must not silence the
    // board either, so it falls through to the window's own answer.
    expect(briefVerdict({ ...BASE, checkedIn: { checkedIn: 0, total: 0 } }).kind).toBe("ready");
    expect(briefVerdict({ ...BASE, checkedIn: null }).kind).toBe("ready");
  });

  it("reports how many are short on every state that knows", () => {
    expect(briefVerdict({ ...BASE, checkedIn: { checkedIn: 2, total: 5 } }).short).toBe(3);
    expect(
      briefVerdict({ ...BASE, window: BLOCKED, checkedIn: { checkedIn: 2, total: 5 } }).short,
    ).toBe(3);
    expect(briefVerdict(BASE).short).toBe(0);
  });

  it("only ever asks for a press in the two states that are one", () => {
    const kinds = (
      ["quiet", "early", "ready", "waiting", "pull-now", "grace", "blocked"] as const
    ).map((k) => {
      switch (k) {
        case "quiet":
          return briefVerdict({ ...BASE, called: false });
        case "early":
          return briefVerdict({ ...BASE, window: EARLY });
        case "ready":
          return briefVerdict(BASE);
        case "waiting":
          return briefVerdict({ ...BASE, checkedIn: { checkedIn: 2, total: 5 } });
        case "pull-now":
          return briefVerdict({
            ...BASE,
            checkedIn: { checkedIn: 2, total: 5 },
            calledForMs: 9 * M,
          });
        case "grace":
          return briefVerdict({ ...BASE, window: GRACE });
        case "blocked":
          return briefVerdict({ ...BASE, window: BLOCKED });
      }
    });
    expect(
      kinds
        .filter((v) => v.act)
        .map((v) => v.kind)
        .sort(),
    ).toEqual(["pull-now", "ready"]);
  });
});
