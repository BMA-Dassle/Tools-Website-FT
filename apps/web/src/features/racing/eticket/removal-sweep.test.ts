import { describe, expect, it } from "vitest";
import {
  REMOVAL_GRACE_MS,
  buildRemovalSmsBody,
  removalVerdict,
  type NotifiedRacer,
  type VerdictInput,
} from "./removal-sweep";

const SESSION = "57900674";
const PERSON = "18586763";
const NOW = 1_700_000_000_000;

/** Baseline: racer IS in the all-state roster but NOT the active one (the
 *  positive F_PAR_STATE = 5 signal), no move signals, grace already elapsed. */
function base(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    active: new Set<string>(["999"]),
    allStates: new Set<string>(["999", PERSON]),
    activeElsewhere: new Set<string>(),
    ticketMoved: false,
    refSessionId: null,
    firstSeenMs: NOW - REMOVAL_GRACE_MS - 1,
    nowMs: NOW,
    ...over,
  };
}

describe("removalVerdict", () => {
  it("retracts a genuinely scratched racer", () => {
    expect(removalVerdict(SESSION, PERSON, base())).toEqual({ act: true });
  });

  it("says nothing while the racer is still on the active roster", () => {
    const v = removalVerdict(SESSION, PERSON, base({ active: new Set([PERSON, "999"]) }));
    expect(v).toEqual({ act: false, reason: "still-on-roster" });
  });

  // The distinction the whole feature rests on: absent from BOTH lists is a
  // partial/failed payload, not a removal. Acting on it would text racers
  // mid-outage that their race had vanished.
  it("does NOT treat absence from the all-state roster as removal", () => {
    const v = removalVerdict(SESSION, PERSON, base({ allStates: new Set(["999"]) }));
    expect(v).toEqual({ act: false, reason: "never-on-roster" });
  });

  describe("move guards — a move must never produce a removal SMS", () => {
    it("G1: racer is live on another heat's active roster", () => {
      const v = removalVerdict(SESSION, PERSON, base({ activeElsewhere: new Set([PERSON]) }));
      expect(v).toEqual({ act: false, reason: "moved" });
    });

    it("G2: the move path already stamped movedTo on the old ticket", () => {
      expect(removalVerdict(SESSION, PERSON, base({ ticketMoved: true }))).toEqual({
        act: false,
        reason: "moved",
      });
    });

    it("G3: participant index now points at a different session", () => {
      expect(removalVerdict(SESSION, PERSON, base({ refSessionId: "57954190" }))).toEqual({
        act: false,
        reason: "moved",
      });
    });

    it("G3 does not fire when the index still points at THIS session", () => {
      expect(removalVerdict(SESSION, PERSON, base({ refSessionId: SESSION }))).toEqual({
        act: true,
      });
    });

    it("G3 tolerates number/string drift in the session id", () => {
      const v = removalVerdict(SESSION, PERSON, base({ refSessionId: Number(SESSION) as never }));
      expect(v).toEqual({ act: true });
    });

    // Ordering matters: a moved racer must be rejected as "moved" and never
    // sit accruing grace, or they would eventually be texted anyway.
    it("reports moved (not waiting-grace) when both apply", () => {
      const v = removalVerdict(SESSION, PERSON, base({ ticketMoved: true, firstSeenMs: NOW }));
      expect(v).toEqual({ act: false, reason: "moved" });
    });
  });

  describe("grace period", () => {
    it("waits on first sighting", () => {
      expect(removalVerdict(SESSION, PERSON, base({ firstSeenMs: NOW }))).toEqual({
        act: false,
        reason: "waiting-grace",
      });
    });

    it("still waits one millisecond short of the window", () => {
      const v = removalVerdict(SESSION, PERSON, base({ firstSeenMs: NOW - REMOVAL_GRACE_MS + 1 }));
      expect(v).toEqual({ act: false, reason: "waiting-grace" });
    });

    it("fires exactly at the window", () => {
      const v = removalVerdict(SESSION, PERSON, base({ firstSeenMs: NOW - REMOVAL_GRACE_MS }));
      expect(v).toEqual({ act: true });
    });

    it("treats a missing first-sighting as not yet waited", () => {
      expect(removalVerdict(SESSION, PERSON, base({ firstSeenMs: null }))).toEqual({
        act: false,
        reason: "waiting-grace",
      });
    });

    // 6 minutes is three ticks of the 2-minute pre-race cron — the move path
    // gets several chances to claim the racer before this one can act.
    it("is at least three pre-race cron ticks long", () => {
      expect(REMOVAL_GRACE_MS).toBeGreaterThanOrEqual(3 * 2 * 60 * 1000);
    });
  });
});

describe("buildRemovalSmsBody", () => {
  const racer: NotifiedRacer = {
    personId: PERSON,
    phone: "+12392461782",
    firstName: "Lexiel",
    track: "Blue",
    heatNumber: 43,
    scheduledStart: "2026-08-06T23:24:00.000Z",
  };

  // Any non-GSM-7 character flips the whole message to UCS-2 (67 chars per
  // segment instead of 153) — the exact regression that quietly turned the
  // pre-race body into a multi-segment send.
  it("is GSM-7 safe (ASCII only)", () => {
    expect(buildRemovalSmsBody(racer)).toMatch(/^[\x20-\x7E\n]*$/);
  });

  it("names the racer and the heat they are off", () => {
    const body = buildRemovalSmsBody(racer);
    expect(body).toContain("Lexiel");
    expect(body).toContain("Blue Heat 43");
    expect(body).toContain("no longer valid");
  });

  it("stays inside two SMS segments", () => {
    expect(buildRemovalSmsBody(racer).length).toBeLessThanOrEqual(306);
  });

  it("falls back gracefully when the name is missing", () => {
    const body = buildRemovalSmsBody({ ...racer, firstName: "" });
    expect(body).toContain("Your racer");
    expect(body).not.toContain("undefined");
  });

  it("omits the time rather than printing a broken one", () => {
    const body = buildRemovalSmsBody({ ...racer, scheduledStart: "not-a-date" });
    expect(body).not.toContain("Invalid");
    expect(body).toContain("Blue Heat 43");
  });
});
