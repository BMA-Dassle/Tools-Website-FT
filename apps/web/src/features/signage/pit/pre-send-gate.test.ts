import { describe, expect, it } from "vitest";
import { CLEAR_TO_SEND_MS, preRaceTone, preSendGateAt, type PitLaneFeed } from "./pit-board";

const T0 = 1_786_900_000_000;

const gate = (over: Partial<NonNullable<PitLaneFeed["preGate"]>> = {}) => ({
  sessionId: "58599054",
  heatNumber: 12,
  startedAtMs: null,
  preRaceAtMs: null,
  preRaceDurationS: null,
  ...over,
});

/**
 * RED HEAT 12, 2026-08-16. Green flag 1:21:42, pre played 1:22:28 — 46 seconds
 * late, which took the debt path and left the group in the stored seats. Red
 * heat 3 skipped the pre entirely and jammed the lane for the rest of the day.
 * Both are invisible on every screen; this rule is what makes them loud.
 */
describe("preSendGateAt", () => {
  it("says nothing while the group is still in the seats", () => {
    // No green flag yet — the pre is not late, it is simply not played. Warning
    // here would fire through every ordinary briefing and train staff to ignore it.
    expect(preSendGateAt(gate(), T0).state).toBe("none");
  });

  it("STOPS SENDING once they have gone green with no pre", () => {
    const g = gate({ startedAtMs: T0 });
    expect(preSendGateAt(g, T0 + 1_000)).toEqual({ state: "pre-required", heatNumber: 12 });
  });

  it("clears the moment the cue is claimed, before the PA has answered", () => {
    // claimAndPlay writes the stamp NX BEFORE calling the player, so the press
    // itself takes the banner down — no waiting on the clip.
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0 + 46_000, preRaceDurationS: 30 });
    expect(preSendGateAt(g, T0 + 46_100).state).toBe("none");
  });

  it("comes BACK if the play failed and the claim was released", () => {
    // A failed play DELetes the stamp, so the next pulse sees no pre again.
    const g = gate({ startedAtMs: T0, preRaceAtMs: null });
    expect(preSendGateAt(g, T0 + 50_000).state).toBe("pre-required");
  });

  it("stays quiet WHILE the cue is sounding", () => {
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0, preRaceDurationS: 30 });
    expect(preSendGateAt(g, T0 + 29_000).state).toBe("none");
  });

  it("flashes CLEAR TO SEND once the cue has finished", () => {
    const g = gate({ preRaceAtMs: T0, preRaceDurationS: 30 });
    expect(preSendGateAt(g, T0 + 30_500)).toEqual({ state: "clear-to-send", heatNumber: 12 });
  });

  it("green is a flash, not a state — it expires", () => {
    const g = gate({ preRaceAtMs: T0, preRaceDurationS: 30 });
    expect(preSendGateAt(g, T0 + 30_000 + CLEAR_TO_SEND_MS).state).toBe("clear-to-send");
    expect(preSendGateAt(g, T0 + 30_000 + CLEAR_TO_SEND_MS + 1).state).toBe("none");
  });

  it("greens the HEALTHY flow too — pre before the green flag", () => {
    // The ordinary night: the cue plays while they are still seated, so there is
    // no start marker yet. That must still earn its confirmation.
    const g = gate({ startedAtMs: null, preRaceAtMs: T0, preRaceDurationS: 25 });
    expect(preSendGateAt(g, T0 + 26_000).state).toBe("clear-to-send");
  });

  it("assumes 60s when the player never reported a length", () => {
    // Over-estimating delays a green flash; under-estimating would tell staff to
    // send while the announcement is still sounding.
    const g = gate({ preRaceAtMs: T0, preRaceDurationS: null });
    expect(preSendGateAt(g, T0 + 59_000).state).toBe("none");
    expect(preSendGateAt(g, T0 + 61_000).state).toBe("clear-to-send");
  });

  it("says nothing for an empty lane", () => {
    expect(preSendGateAt(null, T0)).toEqual({ state: "none", heatNumber: null });
  });
});

/**
 * THE PILL FLIPS ON THE PRESS (owner 2026-08-16). claimAndPlay writes the stamp
 * with `durationS: null` and only fills the real length in once the player
 * answers — so a rule that demanded a duration skipped "playing" for the second
 * in between, and skipped it for ever whenever the player reported no length.
 */
describe("preRaceTone", () => {
  const seated = {
    inHolding: true,
    preRaceAtMs: null as number | null,
    preRaceDurationS: null as number | null,
  };

  it("says nothing for a group that is neither seated nor has played a cue", () => {
    expect(preRaceTone({ ...seated, inHolding: false }, false, T0)).toBeNull();
  });

  it("is DUE while the group is seated and the cue has not fired", () => {
    expect(preRaceTone(seated, false, T0)?.tone).toBe("due");
  });

  it("flips to PLAYING on the press, before the player has reported a length", () => {
    // The NX claim is written first, with durationS null. This is the window
    // that used to read "Pre-race ✓".
    const s = { ...seated, preRaceAtMs: T0, preRaceDurationS: null };
    expect(preRaceTone(s, false, T0 + 200)).toEqual({ label: "Pre-race playing", tone: "playing" });
  });

  it("HOLDS at playing when the player never reports a length at all", () => {
    const s = { ...seated, preRaceAtMs: T0, preRaceDurationS: null };
    expect(preRaceTone(s, false, T0 + 5 * 60_000)?.tone).toBe("playing");
  });

  it("uses the reported length exactly when there is one", () => {
    const s = { ...seated, preRaceAtMs: T0, preRaceDurationS: 30 };
    expect(preRaceTone(s, false, T0 + 29_000)?.tone).toBe("playing");
    expect(preRaceTone(s, false, T0 + 31_000)?.tone).toBe("done");
  });

  it("is READY TO SEND once the cue has fired and the race is armed", () => {
    const s = { ...seated, preRaceAtMs: T0, preRaceDurationS: 30 };
    expect(preRaceTone(s, true, T0 + 31_000)).toEqual({ label: "Ready to send", tone: "ready" });
  });

  it("an armed race with NO cue still says due — the cue is what sends them", () => {
    expect(preRaceTone(seated, true, T0)?.tone).toBe("due");
  });

  it("an unknown length stops holding once the race arms", () => {
    const s = { ...seated, preRaceAtMs: T0, preRaceDurationS: null };
    expect(preRaceTone(s, true, T0 + 5 * 60_000)?.tone).toBe("ready");
  });
});
