import { describe, expect, it } from "vitest";

import { buildVipAlmostHereEmail, buildVipAlmostHereSms } from "./almost-here";

const NON_GSM7_RE = /[^\x00-\x7F]/;

describe("buildVipAlmostHereSms", () => {
  it("stays a single GSM-7 segment (<=160 chars, ASCII only)", () => {
    const body = buildVipAlmostHereSms();
    expect(body.length).toBeLessThanOrEqual(160);
    expect(NON_GSM7_RE.test(body)).toBe(false);
  });

  it("carries the check-in instructions", () => {
    const body = buildVipAlmostHereSms();
    expect(body).toContain("FastTrax: Your VIP Experience is almost here!");
    expect(body).toContain("side door");
    expect(body).toContain("1st floor");
    expect(body).toContain("turn left");
    expect(body).toContain("Group Event counter");
  });
});

describe("buildVipAlmostHereEmail", () => {
  const args = {
    comboName: "Ultimate VIP Experience",
    guestFirstName: "Jordan",
    startTimeLabel: "6:00 PM",
  };

  it("subject leads with the almost-here hook and the start time", () => {
    const { subject } = buildVipAlmostHereEmail(args);
    expect(subject).toBe("Your VIP Experience is almost here — see you at 6:00 PM");
  });

  it("html greets by name, names the combo, and spells out the full check-in route", () => {
    const { html } = buildVipAlmostHereEmail(args);
    expect(html).toContain("Hey Jordan!");
    expect(html).toContain("Ultimate VIP Experience");
    expect(html).toContain("6:00 PM");
    expect(html).toContain("Your VIP Experience Is Almost Here!");
    expect(html).toContain("side door of FastTrax on the first floor");
    expect(html).toContain("turn left when entering");
    expect(html).toContain("Group Event counter");
  });

  it("text fallback carries the same instructions", () => {
    const { text } = buildVipAlmostHereEmail(args);
    expect(text).toContain("side door of FastTrax");
    expect(text).toContain("Group Event counter");
  });
});
