import { describe, it, expect } from "vitest";
import { classifyInbound, normalizeBody } from "./inbound-keywords";

describe("normalizeBody", () => {
  it("makes the trailing-space form identical to the bare keyword", () => {
    // The literal first inbound message we ever captured was "Start " —
    // mixed case, trailing space. A naive equality check would miss it.
    expect(normalizeBody("Start ")).toBe("start");
    expect(normalizeBody("  STOP  ")).toBe("stop");
  });

  it("strips zero-width characters a guest cannot see", () => {
    expect(normalizeBody("ST​OP")).toBe("stop");
    expect(normalizeBody("﻿STOP")).toBe("stop");
  });

  it("folds curly apostrophes so don't and don’t match alike", () => {
    expect(normalizeBody("Don’t text me")).toBe("don't text me");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeBody("stop    texting   me")).toBe("stop texting me");
  });
});

describe("classifyInbound — bare opt-out keywords auto-action", () => {
  // Every mandatory CTIA keyword, in the punctuation and casing forms
  // T-Mobile CoC 2.11 says must not defeat an opt-out.
  const bare = [
    "STOP",
    "stop",
    "Stop.",
    "STOP!",
    "  stop  ",
    "STOP ",
    "stopall",
    "STOP ALL",
    "UNSUBSCRIBE",
    "unsubscribe.",
    "END",
    "QUIT",
    "CANCEL",
    "REVOKE",
    "OPTOUT",
    "OPT OUT",
    "opt-out",
  ];
  for (const body of bare) {
    it(`opts out on ${JSON.stringify(body)}`, () => {
      const r = classifyInbound(body);
      expect(r.action).toBe("opt_out");
      expect(r.priority).toBe("high");
    });
  }
});

describe("classifyInbound — opt-in", () => {
  it("auto-actions START in the exact form we captured", () => {
    expect(classifyInbound("Start ").action).toBe("opt_in");
  });

  it("auto-actions UNSTOP and RESUME", () => {
    expect(classifyInbound("UNSTOP").action).toBe("opt_in");
    expect(classifyInbound("resume").action).toBe("opt_in");
  });

  it("does NOT manufacture consent from a bare YES", () => {
    // Asymmetric risk: a wrong opt-out delays a message, a wrong opt-in
    // makes every later send unconsented on a record we forged.
    const r = classifyInbound("Yes");
    expect(r.action).toBe("review");
    expect(r.reviewReason).toBe("ambiguous_opt_in");
  });

  it("does not treat OK as consent either", () => {
    expect(classifyInbound("ok").action).toBe("review");
  });
});

describe("classifyInbound — HELP", () => {
  it("answers a bare HELP", () => {
    expect(classifyInbound("HELP").action).toBe("help");
    expect(classifyInbound("info").action).toBe("help");
  });

  it("routes HELP inside a sentence to review, not the canned reply", () => {
    const r = classifyInbound("can you help me find my race time");
    expect(r.action).toBe("review");
  });
});

describe("classifyInbound — T-Mobile CoC 2.11 worked examples", () => {
  // These three are T-Mobile's OWN examples of messages that must result
  // in an opt-out. We flag rather than auto-action, but they MUST be
  // high priority or the queue buries them.
  const mustBeHonored = ["please stop texting me", "you have the wrong number, stop", "Stop it!"];
  for (const body of mustBeHonored) {
    it(`flags ${JSON.stringify(body)} as high priority`, () => {
      const r = classifyInbound(body);
      expect(r.action).toBe("review");
      expect(r.priority).toBe("high");
    });
  }

  it("does NOT flag T-Mobile's counter-example as a revocation", () => {
    // "I cannot get my device to stop, can you help?" — contains STOP but
    // is a support request. Must not be pushed at a staffer as an opt-out.
    const r = classifyInbound("I cannot get my device to stop, can you help?");
    expect(r.action).toBe("review");
    expect(r.reviewReason).toBe("ambiguous_keyword");
    expect(r.priority).toBe("normal");
  });
});

describe("classifyInbound — plain-language revocations with no keyword", () => {
  const phrases = [
    "take me off your list",
    "remove me please",
    "do not text me again",
    "don't text me anymore",
    "no more texts please",
    "leave me alone",
    "lose my number",
    "delete my number from your system",
  ];
  for (const body of phrases) {
    it(`flags ${JSON.stringify(body)} high — 64.1200(a)(11)`, () => {
      const r = classifyInbound(body);
      expect(r.action).toBe("review");
      expect(r.priority).toBe("high");
    });
  }
});

describe("classifyInbound — must NOT false-positive", () => {
  // Ordinary guest traffic. Every one of these opting someone out would
  // cost them the e-ticket that admits them to the track.
  const innocuous = [
    "what time is my race",
    "can I move to a later heat",
    "thanks!",
    "how many races do we get",
    "is the track open today",
    "we are running late",
    "my son is 7 can he race",
  ];
  for (const body of innocuous) {
    it(`leaves ${JSON.stringify(body)} alone`, () => {
      const r = classifyInbound(body);
      expect(r.action).toBe("review");
      expect(r.reviewReason).toBe("unclassified");
      expect(r.priority).toBe("normal");
    });
  }

  it("does not auto-opt-out a call-center-style cancellation", () => {
    // This handler must never see this — the 3CX Messaging Application
    // keeps call-center DIDs separate. Belt and braces: if one ever
    // arrives, CANCEL inside a sentence must not fire automatically.
    const r = classifyInbound("cancel my 4pm");
    expect(r.action).not.toBe("opt_out");
  });
});

describe("classifyInbound — degenerate input", () => {
  it("handles an empty body", () => {
    const r = classifyInbound("");
    expect(r.action).toBe("review");
    expect(r.matched).toBeNull();
  });

  it("handles whitespace only", () => {
    expect(classifyInbound("   ").action).toBe("review");
  });

  it("always reports what it matched on, for the admin queue", () => {
    expect(classifyInbound("STOP").matched).toBe("stop");
    expect(classifyInbound("please stop texting me").matched).toBe("stop texting");
  });
});
