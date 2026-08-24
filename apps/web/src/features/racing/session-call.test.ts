import { describe, expect, it } from "vitest";
import { CALL_LEAD_MIN } from "./on-time";
import {
  CALL_WINDOW_MIN,
  GUEST_BOOKING_LEAD_MIN,
  PIPELINE_LEAD_MIN,
  PRO_CALL_DELAY_MIN,
  callAtMs,
  callStateAt,
  isProCall,
  nextCheckIn,
  type CallGridSlot,
} from "./session-call";

const MIN = 60_000;
/** A fixed slot to hang every case off. 2026-08-16 19:45 ET. */
const SLOT = Date.parse("2026-08-16T23:45:00.000Z");
const at = (min: number) => SLOT + min * MIN;

/** The grid a real night looks like: a 12-minute cadence per track. */
function grid(
  entries: Array<{ heat: number; atMin: number; booked: number | null; called?: number | null }>,
): CallGridSlot[] {
  return entries.map((e) => ({
    sessionId: `58${600000 + e.heat}`,
    heatNumber: e.heat,
    slotMs: at(e.atMin),
    booked: e.booked,
    calledAtMs: e.called ?? null,
  }));
}

describe("callAtMs", () => {
  it("falls back to the desk's flat rule when we have no offset", () => {
    expect(callAtMs(SLOT, null)).toBe(at(-CALL_LEAD_MIN));
  });

  it("lands on the desk's measured behaviour at the measured median offset", () => {
    // 6-night median slot→flag drift was +17.6, and the desk's median call was
    // slot −4.3. 17.6 − 22 = −4.4, so the flag-anchored rule reproduces it.
    expect(callAtMs(SLOT, 17.6)).toBeCloseTo(at(-4.4), -2);
  });

  it("NEVER advises calling 22 minutes early when the offset reads zero", () => {
    // The hazard: a dead feed reads as "on time". Un-clamped this would be
    // slot − 22, before the guests are even due to arrive.
    expect(callAtMs(SLOT, 0)).toBe(at(-CALL_LEAD_MIN));
    expect(callAtMs(SLOT, 0)).toBeGreaterThan(at(-PIPELINE_LEAD_MIN));
  });

  it("clamps every offset that would call before the guests are due", () => {
    for (const offset of [0, 5, 10, 16, PIPELINE_LEAD_MIN - CALL_LEAD_MIN]) {
      expect(callAtMs(SLOT, offset)).toBe(at(-CALL_LEAD_MIN));
    }
  });

  it("slides later as the track falls further behind", () => {
    expect(callAtMs(SLOT, 30)).toBe(at(30 - PIPELINE_LEAD_MIN));
    expect(callAtMs(SLOT, 40)).toBe(at(40 - PIPELINE_LEAD_MIN));
    expect(callAtMs(SLOT, 40)).toBeGreaterThan(callAtMs(SLOT, 30));
  });

  it("treats a non-finite offset as no offset", () => {
    expect(callAtMs(SLOT, Number.NaN)).toBe(at(-CALL_LEAD_MIN));
  });
});

describe("callStateAt", () => {
  const callAt = at(-CALL_LEAD_MIN);

  it("is quiet before the window opens", () => {
    expect(callStateAt(callAt, at(-12))).toBe("quiet");
    expect(callStateAt(callAt, callAt - 1)).toBe("quiet");
  });

  it("is due from the moment the window opens", () => {
    expect(callStateAt(callAt, callAt)).toBe("due");
  });

  it("reproduces the owner's window exactly: slot −5 through slot +2", () => {
    expect(callStateAt(callAt, at(-5))).toBe("due");
    expect(callStateAt(callAt, at(0))).toBe("due");
    expect(callStateAt(callAt, at(+2))).toBe("due");
    expect(callStateAt(callAt, at(+2) + 1)).toBe("overdue");
    expect(CALL_WINDOW_MIN).toBe(7);
  });
});

describe("nextCheckIn — which session, and what state", () => {
  it("picks the earliest uncalled session that has people in it", () => {
    const slots = grid([
      { heat: 33, atMin: -12, booked: 7, called: at(-17) },
      { heat: 34, atMin: 0, booked: 8 },
      { heat: 35, atMin: 12, booked: 6 },
    ]);
    const next = nextCheckIn(slots, at(-6), 17.6);
    expect(next?.heatNumber).toBe(34);
    expect(next?.booked).toBe(8);
  });

  it("says nothing about a session with nobody booked", () => {
    const slots = grid([{ heat: 36, atMin: 0, booked: 0 }]);
    expect(nextCheckIn(slots, at(-6), 17.6)).toBeNull();
  });

  it("says nothing when we do not KNOW who is booked", () => {
    // The warm participants record is missing exactly when Pandora is unhappy.
    // Unknown is not a reason to nag.
    const slots = grid([{ heat: 36, atMin: 0, booked: null }]);
    expect(nextCheckIn(slots, at(-6), 17.6)).toBeNull();
  });

  it("skips an empty slot to warn about the booked one behind it", () => {
    const slots = grid([
      { heat: 34, atMin: 0, booked: 0 },
      { heat: 35, atMin: 12, booked: 6 },
    ]);
    expect(nextCheckIn(slots, at(-6), 17.6)?.heatNumber).toBe(35);
  });

  it("gives up on a slot long past — it is an artefact, not a call", () => {
    const slots = grid([{ heat: 34, atMin: 0, booked: 8 }]);
    expect(nextCheckIn(slots, at(45), 17.6)).toBeNull();
  });

  it("ignores a session once BMI reports it called", () => {
    const slots = grid([{ heat: 34, atMin: 0, booked: 8, called: at(-4) }]);
    expect(nextCheckIn(slots, at(-3), 17.6)).toBeNull();
  });

  it("counts whole minutes overdue past the end of the window", () => {
    const slots = grid([{ heat: 34, atMin: 0, booked: 8 }]);
    const next = nextCheckIn(slots, at(6), null);
    expect(next?.state).toBe("overdue");
    expect(next?.overdueMin).toBe(4); // window closed at +2
  });

  it("never reports a zero-minute overdue", () => {
    const slots = grid([{ heat: 34, atMin: 0, booked: 8 }]);
    const next = nextCheckIn(slots, at(2) + 1_000, null);
    expect(next?.state).toBe("overdue");
    expect(next?.overdueMin).toBe(1);
  });

  it("accepts the grid in any order", () => {
    const slots = grid([
      { heat: 35, atMin: 12, booked: 6 },
      { heat: 34, atMin: 0, booked: 8 },
    ]);
    expect(nextCheckIn(slots, at(-6), null)?.heatNumber).toBe(34);
  });
});

describe("nextCheckIn — the wall gate", () => {
  it("is safe when every slot in front is already booked", () => {
    const slots = grid([
      { heat: 33, atMin: -12, booked: 7, called: at(-17) },
      { heat: 34, atMin: 0, booked: 8 },
    ]);
    expect(nextCheckIn(slots, at(-6), null)?.wallSafe).toBe(true);
  });

  it("is NOT safe while an empty slot in front can still be booked", () => {
    // Empty heat 34 at +0 sits in front of booked heat 35 at +12, and at −20
    // it is still 20 minutes out — a returning racer could take it on the kiosk.
    const slots = grid([
      { heat: 34, atMin: 0, booked: 0 },
      { heat: 35, atMin: 12, booked: 6 },
    ]);
    const next = nextCheckIn(slots, at(-20), null);
    expect(next?.heatNumber).toBe(35);
    expect(next?.wallSafe).toBe(false);
  });

  it("becomes safe once that empty slot is too soon to book", () => {
    const slots = grid([
      { heat: 34, atMin: 0, booked: 0 },
      { heat: 35, atMin: 12, booked: 6 },
    ]);
    // Inside the tightest guest booking lead of the empty slot ⇒ unsellable.
    const next = nextCheckIn(slots, at(-GUEST_BOOKING_LEAD_MIN + 1), null);
    expect(next?.wallSafe).toBe(true);
  });

  it("treats an unknown count in front as a threat, not as empty", () => {
    const slots = grid([
      { heat: 34, atMin: 0, booked: null },
      { heat: 35, atMin: 12, booked: 6 },
    ]);
    expect(nextCheckIn(slots, at(-20), null)?.wallSafe).toBe(false);
  });

  it("does not treat an already-called slot in front as a threat", () => {
    const slots = grid([
      { heat: 34, atMin: 0, booked: 0, called: at(-4) },
      { heat: 35, atMin: 12, booked: 6 },
    ]);
    expect(nextCheckIn(slots, at(-20), null)?.wallSafe).toBe(true);
  });
});

describe("the ugly case — Saturday 2026-08-16's opening heat", () => {
  /**
   * The real night: red's 11:12 slot did not go green until 11:43 (+32), and the
   * desk called it at 11:33 — 21 minutes PAST the slot. The measured worst case,
   * and the one a rule built on medians gets wrong.
   */
  const slot = Date.parse("2026-08-16T15:12:00.000Z");
  const slotAt = (min: number) => slot + min * MIN;

  it("advises calling +10, close to the 11:33 the desk actually managed", () => {
    // offset +32 ⇒ 32 − 22 = +10 past the slot.
    expect(callAtMs(slot, 32)).toBe(slotAt(10));
  });

  it("still reads the real 11:33 call as inside the window, not a failure", () => {
    // Called at +21 against a window opening at +10 and closing at +17 — so it
    // WAS late, and the board should have said so. This documents that: the
    // rule is not being tuned until the night it was measured on passes.
    expect(callStateAt(callAtMs(slot, 32), slotAt(21))).toBe("overdue");
  });

  it("would have gone amber at +10 with the group still uncalled", () => {
    const slots: CallGridSlot[] = [
      { sessionId: "58598907", heatNumber: 1, slotMs: slot, booked: 5, calledAtMs: null },
    ];
    const next = nextCheckIn(slots, slotAt(10), 32);
    expect(next?.state).toBe("due");
    expect(next?.overdueMin).toBe(0);
  });
});

/**
 * THE PRO DELAY. Pro grids skip the 4:30 briefing film, so they are ready in
 * holding ~8 minutes sooner and stand there longest — but the pro chain's tail
 * reaches 32 minutes, and a 4-minute delay replayed against 8/20 turned 1 late
 * group into 6. Two minutes is what the tail allows.
 */
describe("callAtMs — the Pro delay", () => {
  it("calls a Pro grid exactly two minutes later than the house lead", () => {
    expect(callAtMs(SLOT, null, "Pro")).toBe(at(-CALL_LEAD_MIN + PRO_CALL_DELAY_MIN));
  });

  it("moves the flag-anchored form by the same two minutes", () => {
    const house = callAtMs(SLOT, 25, null);
    expect(callAtMs(SLOT, 25, "Pro") - house).toBe(PRO_CALL_DELAY_MIN * MIN);
  });

  it("leaves every tier that watches a film on the house lead", () => {
    for (const t of ["Starter", "Junior Starter", "Intermediate", "Intermediate (2)", null]) {
      expect(callAtMs(SLOT, null, t)).toBe(at(-CALL_LEAD_MIN));
    }
  });

  it("treats a Junior Pro grid as a film-watching tier, not a Pro one", () => {
    // A junior grid gets the junior briefing whatever else the name says.
    expect(callAtMs(SLOT, null, "Junior Pro")).toBe(at(-CALL_LEAD_MIN));
  });

  it("still never advises calling before the guests are due", () => {
    // The delay may only ever push a call LATER, so the clamp still holds.
    expect(callAtMs(SLOT, 0, "Pro")).toBeGreaterThanOrEqual(at(-CALL_LEAD_MIN));
  });

  it("reads the tier off the name the way the film resolver does", () => {
    expect(isProCall("Pro")).toBe(true);
    expect(isProCall("pro")).toBe(true);
    expect(isProCall("Red Pro 41")).toBe(true);
    expect(isProCall("Junior Pro")).toBe(false);
    expect(isProCall("Starter")).toBe(false);
    expect(isProCall(null)).toBe(false);
    expect(isProCall(undefined)).toBe(false);
  });
});

describe("nextCheckIn — carries the tier into the call time", () => {
  it("delays the Pro session it names", () => {
    const slots: CallGridSlot[] = [
      { sessionId: "9001", heatNumber: 61, slotMs: at(10), booked: 6, type: "Pro" },
    ];
    const got = nextCheckIn(slots, at(0), null);
    expect(got?.callAtMs).toBe(at(10 - CALL_LEAD_MIN + PRO_CALL_DELAY_MIN));
  });

  it("leaves a Starter session on the house lead", () => {
    const slots: CallGridSlot[] = [
      { sessionId: "9002", heatNumber: 62, slotMs: at(10), booked: 6, type: "Starter" },
    ];
    expect(nextCheckIn(slots, at(0), null)?.callAtMs).toBe(at(10 - CALL_LEAD_MIN));
  });
});
