import { describe, expect, it } from "vitest";
import {
  REQUESTED_REP_STEP_ID,
  REQUESTED_REP_STEP_LABEL,
  requestedRepVerdict,
  sellsAt,
  type DecisionLike,
  type RequestedRepLike,
} from "./requested-rep";

/**
 * The owner's precedence table (2026-09-13 14:05), one case per row. The
 * request beats the balancing rule and nothing else; whenever it loses, the
 * lead still carries it and the note says which rule won.
 */

const kelsea: RequestedRepLike = {
  id: "1",
  slug: "kelsea",
  firstName: "Kelsea",
  displayName: "Kelsea Kosco",
  centres: ["HPFM", "FT"],
  active: true,
  role: "rep",
};

const lori: RequestedRepLike = {
  id: "2",
  slug: "lori",
  firstName: "Lori",
  displayName: "Lori Lehman",
  centres: ["HPFM"],
  active: true,
  role: "rep",
};

const gs: RequestedRepLike = {
  id: "4",
  slug: "gs",
  firstName: "Guest Services",
  displayName: "Guest Services",
  centres: ["HPFM", "FT", "HPN"],
  active: true,
  role: "bucket",
};

const mkt: RequestedRepLike = {
  id: "5",
  slug: "mkt",
  firstName: "Marketing",
  displayName: "Marketing Director",
  centres: ["HPFM", "FT", "HPN"],
  active: true,
  role: "hold",
};

const standardPickedLori: DecisionLike = {
  rep: lori,
  reason: "lowest Oct volume",
  outcome: "assign",
  finalRuleId: "6",
};

const heldForMarketing: DecisionLike = {
  rep: mkt,
  reason: "held for Marketing Director",
  outcome: "hold",
  finalRuleId: "1",
};

const routedToGs: DecisionLike = {
  rep: gs,
  reason: "routed to Guest Services",
  outcome: "route",
  finalRuleId: "3",
};

const queued: DecisionLike = {
  rep: null,
  reason: "waits for Jacob",
  outcome: "queue",
  finalRuleId: "7",
};

describe("requestedRepVerdict", () => {
  it("no request — the rules' own pick stands, with no note", () => {
    const v = requestedRepVerdict({
      requested: null,
      centre: "HPFM",
      kidsBirthday: false,
      decision: standardPickedLori,
    });
    expect(v.outcome).toBe("none");
    expect(v.honoured).toBe(false);
    expect(v.rep).toBe(lori);
    expect(v.reason).toBe("lowest Oct volume");
    expect(v.note).toBe("");
  });

  it("honoured: the request beats the lowest-volume rule", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "HPFM",
      kidsBirthday: false,
      decision: standardPickedLori,
    });
    expect(v.outcome).toBe("honoured");
    expect(v.honoured).toBe(true);
    expect(v.rep).toBe(kelsea);
    expect(v.reason).toBe("guest asked for Kelsea");
    expect(v.note).toBe("Guest asked for Kelsea — honoured, ahead of lowest Oct volume");
    expect(v.overriddenBy).toBeNull();
  });

  it("honoured when the rules picked nobody and parked it in the queue", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "FT",
      kidsBirthday: false,
      decision: queued,
    });
    expect(v.outcome).toBe("honoured");
    expect(v.rep).toBe(kelsea);
    expect(v.note).toBe("Guest asked for Kelsea — honoured");
  });

  it("R1 hold wins: a 100-guest party is still held for the Marketing Director", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "HPFM",
      kidsBirthday: false,
      decision: heldForMarketing,
    });
    expect(v.outcome).toBe("overridden");
    expect(v.honoured).toBe(false);
    expect(v.rep).toBe(mkt);
    expect(v.overriddenBy).toBe("1");
    expect(v.note).toBe("Guest asked for Kelsea — held for Marketing Director takes precedence");
  });

  it("R3 route wins: a small school group still goes to Guest Services", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "HPFM",
      kidsBirthday: false,
      decision: routedToGs,
    });
    expect(v.outcome).toBe("overridden");
    expect(v.rep).toBe(gs);
    expect(v.overriddenBy).toBe("3");
    expect(v.note).toBe("Guest asked for Kelsea — routed to Guest Services takes precedence");
  });

  it("R4 availability wins: a planner who is off today is skipped, not left holding it", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "HPFM",
      kidsBirthday: false,
      decision: standardPickedLori,
      offToday: true,
    });
    expect(v.outcome).toBe("unavailable");
    expect(v.honoured).toBe(false);
    expect(v.rep).toBe(lori);
    expect(v.note).toBe(
      "Guest asked for Kelsea — they are off today, so the lead is worked by Lori",
    );
    expect(v.overriddenBy).toBe("6");
  });

  it("a children's birthday ignores the request outright — Pandora force-routes it", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "HPFM",
      kidsBirthday: true,
      decision: routedToGs,
    });
    expect(v.outcome).toBe("ignored");
    expect(v.honoured).toBe(false);
    expect(v.rep).toBe(gs);
    expect(v.note).toBe(
      "Guest asked for Kelsea — children's parties go to Guest Services, so the request is not applied",
    );
  });

  it("a Naples enquiry may not have a Fort Myers-only planner", () => {
    const v = requestedRepVerdict({
      requested: lori,
      centre: "HPN",
      kidsBirthday: false,
      decision: standardPickedLori,
    });
    expect(v.outcome).toBe("unknown");
    expect(v.honoured).toBe(false);
    expect(v.note).toBe(
      "Guest asked for Lori — they do not take HPN events, so the rules decided instead",
    );
  });

  it("a planner who has left the roster is not honoured", () => {
    const v = requestedRepVerdict({
      requested: { ...kelsea, active: false },
      centre: "HPFM",
      kidsBirthday: false,
      decision: standardPickedLori,
    });
    expect(v.outcome).toBe("unknown");
    expect(v.rep).toBe(lori);
  });

  it("a bucket or a hold row is never a planner a guest may request", () => {
    for (const who of [gs, mkt]) {
      const v = requestedRepVerdict({
        requested: who,
        centre: "HPFM",
        kidsBirthday: false,
        decision: standardPickedLori,
      });
      expect(v.outcome).toBe("unknown");
    }
  });

  it("the rules have not run yet: carried, not acted on — never a blind assign", () => {
    const v = requestedRepVerdict({
      requested: kelsea,
      centre: "HPFM",
      kidsBirthday: false,
      decision: null,
    });
    expect(v.outcome).toBe("pending");
    expect(v.honoured).toBe(false);
    expect(v.rep).toBeNull();
    expect(v.note).toBe("Guest asked for Kelsea — waiting for the rules to run");
  });

  it("the trace row is a step, not a stored rule", () => {
    expect(REQUESTED_REP_STEP_ID).toBe("guest-request");
    expect(REQUESTED_REP_STEP_LABEL).toBe("Guest's choice of planner");
  });

  it("sellsAt: centre, roster and role all count", () => {
    expect(sellsAt(kelsea, "FT")).toBe(true);
    expect(sellsAt(kelsea, "HPN")).toBe(false);
    expect(sellsAt({ ...kelsea, active: false }, "FT")).toBe(false);
    expect(sellsAt(gs, "FT")).toBe(false);
    // A shape with neither flag (a PublicRep from an older payload) is judged on centres alone.
    expect(
      sellsAt({ id: "9", slug: "x", firstName: "X", displayName: "X", centres: ["FT"] }, "FT"),
    ).toBe(true);
  });
});
