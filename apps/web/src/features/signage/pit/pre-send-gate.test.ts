import { describe, expect, it } from "vitest";
import {
  CLEAR_TO_SEND_MS,
  kartsAvailability,
  preRaceTone,
  preSendGateAt,
  type PitLaneFeed,
} from "./pit-board";

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
    expect(preSendGateAt(g, T0 + 1_000)).toEqual({
      state: "pre-required",
      heatNumber: 12,
      remainingMs: null,
    });
  });

  it("turns AMBER the moment the cue is claimed, before the PA has answered", () => {
    // claimAndPlay writes the stamp NX BEFORE calling the player, so the press
    // itself takes the red down — no waiting on the clip. What replaces it must
    // not be nothing: see the next test for the night that proved it.
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0 + 46_000, preRaceDurationS: 30 });
    expect(preSendGateAt(g, T0 + 46_100).state).toBe("pre-playing");
  });

  it("comes BACK if the play failed and the claim was released", () => {
    // A failed play DELetes the stamp, so the next pulse sees no pre again.
    const g = gate({ startedAtMs: T0, preRaceAtMs: null });
    expect(preSendGateAt(g, T0 + 50_000).state).toBe("pre-required");
  });

  /**
   * BLUE SESSION 43, 2026-08-16. Green flag 19:42:14, pre pressed 19:42:29 —
   * 15.6s late, and the clip was the BIG pre: 133.8 seconds. The red vanished on
   * the press and the board showed nothing at all until a 5.6s green flash two
   * minutes and fourteen seconds later. Owner: "they hit play then seemed like
   * everything just cleared, didn't show it playing."
   */
  it("SAYS IT IS PLAYING for the whole late clip, counting down", () => {
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0 + 15_600, preRaceDurationS: 133.8 });
    // One second after the press.
    expect(preSendGateAt(g, T0 + 16_600)).toEqual({
      state: "pre-playing",
      heatNumber: 12,
      remainingMs: 132_800,
    });
    // Two minutes in — the window that used to be blank.
    expect(preSendGateAt(g, T0 + 135_600).state).toBe("pre-playing");
    // And it hands straight over to the green, with no gap between them.
    const endsAt = 15_600 + 133_800;
    expect(preSendGateAt(g, T0 + endsAt - 1).state).toBe("pre-playing");
    expect(preSendGateAt(g, T0 + endsAt).state).toBe("clear-to-send");
  });

  it("never goes amber for the healthy flow — the cue predates the flag", () => {
    // The ordinary night. This clip sounds while staff are loading karts, so an
    // amber band every heat would be covering the board it exists to protect.
    const g = gate({ startedAtMs: T0 + 60_000, preRaceAtMs: T0, preRaceDurationS: 90 });
    expect(preSendGateAt(g, T0 + 60_100).state).toBe("none");
  });

  it("flashes CLEAR TO SEND once a LATE cue has finished", () => {
    // Green answers a red: the cue was stamped after the flag, so this group did
    // show STOP SENDING and has now been paid.
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0 + 46_000, preRaceDurationS: 30 });
    expect(preSendGateAt(g, T0 + 76_500)).toEqual({
      state: "clear-to-send",
      heatNumber: 12,
      remainingMs: null,
    });
  });

  it("green is a flash, not a state — it expires", () => {
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0 + 46_000, preRaceDurationS: 30 });
    const endsAt = 46_000 + 30_000;
    expect(preSendGateAt(g, T0 + endsAt + CLEAR_TO_SEND_MS).state).toBe("clear-to-send");
    expect(preSendGateAt(g, T0 + endsAt + CLEAR_TO_SEND_MS + 1).state).toBe("none");
  });

  it("NEVER greens the healthy flow — a cue played before the flag was never red", () => {
    // Owner 2026-08-16, live: "the clear to send blink of green came up even if
    // we never got the red stop." The ordinary night plays the cue while the
    // group is still seated; that earns no banner at all, because a wall whose
    // job is showing spots must not cover them to say "nothing was wrong".
    const g = gate({ startedAtMs: null, preRaceAtMs: T0, preRaceDurationS: 25 });
    expect(preSendGateAt(g, T0 + 26_000).state).toBe("none");
  });

  it("still never greens once the flag lands, if the cue came first", () => {
    // Same group a moment later: they have now gone green, but the cue predates
    // the flag so there was never a debt and never a red.
    const g = gate({ startedAtMs: T0 + 60_000, preRaceAtMs: T0, preRaceDurationS: 25 });
    expect(preSendGateAt(g, T0 + 60_100).state).toBe("none");
  });

  it("assumes 60s when the player never reported a length", () => {
    // Over-estimating delays a green flash; under-estimating would tell staff to
    // send while the announcement is still sounding. The countdown simply
    // reflects the assumption rather than inventing a second one.
    const g = gate({ startedAtMs: T0, preRaceAtMs: T0 + 1_000, preRaceDurationS: null });
    expect(preSendGateAt(g, T0 + 60_000)).toEqual({
      state: "pre-playing",
      heatNumber: 12,
      remainingMs: 1_000,
    });
    expect(preSendGateAt(g, T0 + 62_000).state).toBe("clear-to-send");
  });

  it("says nothing for an empty lane", () => {
    expect(preSendGateAt(null, T0)).toEqual({
      state: "none",
      heatNumber: null,
      remainingMs: null,
    });
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

/**
 * BLUE 17 IN THE SEATS, BLUE 16 STRAPPED IN (owner 2026-08-16, live). The board
 * said PRE-RACE DUE for 17 while 16 waited on the green. Acting on it would have
 * called 17 to karts that were not free, and markInKarts — which the press
 * triggers — wrote that slot with no occupancy check, erasing 16 off the lane.
 *
 * Third instance of one bug: a single slot written without asking who is in it.
 */
describe("kartsAvailability", () => {
  const k = (sessionId: string, heatNumber: number) => ({ sessionId, heatNumber });

  it("allows the cue when the karts are empty", () => {
    expect(kartsAvailability({ karts: null, sessionId: "s17" })).toEqual({ ok: true });
  });

  it("REFUSES while a different group is still in the karts", () => {
    const v = kartsAvailability({ karts: k("s16", 16), sessionId: "s17" });
    expect(v.ok).toBe(false);
    // The refusal names who, because "wait" is only actionable if you know for what.
    expect(v.ok === false && v.error).toContain("Session 16");
  });

  it("allows a REPEAT press for the group already in the karts", () => {
    // playPreRace falls back to `karts` so a second press does not refuse about
    // a group standing right there — that path must stay open.
    expect(kartsAvailability({ karts: k("s16", 16), sessionId: "s16" })).toEqual({ ok: true });
  });

  it("still refuses when the occupant has no heat number to name", () => {
    const v = kartsAvailability({ karts: { sessionId: "s16" }, sessionId: "s17" });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.error).toContain("another group");
  });
});

/**
 * ONE SUBJECT, EVERY SURFACE (owner 2026-08-16: "the pit controller should be
 * showing race that's in the rail"). The wall's rail names `karts ?? holding`;
 * the station card and playPreRace both read `holding ?? karts`. While a group
 * was strapped in, the card named the seated group while the wall named the
 * karts group, and the press -- resolving its own subject server-side -- would
 * have played for whichever one the card was not showing.
 */
describe("the pre subject is the same on every surface", () => {
  const pick = (lane: {
    holding?: { sessionId: string } | null;
    karts?: { sessionId: string } | null;
  }) => lane.karts ?? lane.holding ?? null;

  it("names the karts group while somebody is strapped in", () => {
    expect(pick({ holding: { sessionId: "s22" }, karts: { sessionId: "s21" } })?.sessionId).toBe(
      "s21",
    );
  });

  it("falls through to the seated group the moment the karts clear", () => {
    expect(pick({ holding: { sessionId: "s22" }, karts: null })?.sessionId).toBe("s22");
  });

  it("agrees with holding-first whenever the karts are empty", () => {
    // The two orderings can only differ while the karts are occupied — which is
    // exactly the window the seated group's cue cannot play in anyway.
    const lane = { holding: { sessionId: "s22" }, karts: null };
    expect(pick(lane)).toEqual(lane.holding ?? lane.karts);
  });
});

/**
 * THE DEBT OUTRANKS THE NEXT CYCLE (owner 2026-08-16). The cue used to fall back
 * to the racing group only when NOTHING was staged, so seating the next group
 * did not delay an owed announcement -- it destroyed it, and nothing could reach
 * that group again. Blue 20 went green at 3:05:38 with no pre; the wall said
 * play it; the 3:09:36 press paid blue 21's cycle because 21 was seated; 20 had
 * to be stamped by hand. A banner that instructs an impossible press is worse
 * than no banner.
 */
describe("pre-race subject: an outstanding debt is paid first", () => {
  const pick = (lane: {
    karts?: { sessionId: string } | null;
    holding?: { sessionId: string } | null;
    racing?: { sessionId: string } | null;
    racingHasPre?: boolean;
  }) => {
    const staged = lane.karts ?? lane.holding ?? null;
    if (lane.racing && !lane.racingHasPre) return { subject: lane.racing, late: true };
    return { subject: staged, late: false };
  };

  it("pays the racing group EVEN WHILE the next group is seated", () => {
    const v = pick({ holding: { sessionId: "s21" }, racing: { sessionId: "s20" } });
    expect(v.subject?.sessionId).toBe("s20");
    expect(v.late).toBe(true);
  });

  it("goes to the seated group once the debt is settled", () => {
    const v = pick({
      holding: { sessionId: "s21" },
      racing: { sessionId: "s20" },
      racingHasPre: true,
    });
    expect(v.subject?.sessionId).toBe("s21");
    expect(v.late).toBe(false);
  });

  it("still pays a debt when nothing is staged at all", () => {
    expect(pick({ racing: { sessionId: "s20" } }).subject?.sessionId).toBe("s20");
  });

  it("takes the karts group when nobody is racing", () => {
    const v = pick({ karts: { sessionId: "s22" }, holding: { sessionId: "s23" } });
    expect(v.subject?.sessionId).toBe("s22");
    expect(v.late).toBe(false);
  });
});
