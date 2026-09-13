import { describe, expect, it } from "vitest";
import {
  RosterPostBodySchema,
  RuleInputSchema,
  RulesPostBodySchema,
  TryLeadQuerySchema,
} from "./schemas";

/** The rule shapes the routes accept; kind ⇄ then agreement; query coercion for the try-lead GET. */

describe("RuleInputSchema", () => {
  it("accepts the seeded shapes", () => {
    expect(
      RuleInputSchema.safeParse({
        label: "Big groups go to Marketing",
        kind: "hold",
        when: { guestsMin: 100 },
        then: { hold: "mkt" },
      }).success,
    ).toBe(true);
    expect(
      RuleInputSchema.safeParse({
        label: "Kids",
        kind: "route",
        when: { type: "birthday", kids: true },
        then: { route: "gs" },
      }).success,
    ).toBe(true);
    expect(
      RuleInputSchema.safeParse({ label: "Skip", kind: "avail", then: { skipOff: true } }).success,
    ).toBe(true);
    expect(
      RuleInputSchema.safeParse({ label: "Shift", kind: "avail", then: { onShift: true } }).success,
    ).toBe(true);
    expect(
      RuleInputSchema.safeParse({ label: "Std", kind: "standard", then: { standard: true } })
        .success,
    ).toBe(true);
    expect(
      RuleInputSchema.safeParse({ label: "Q", kind: "fallback", then: { queue: true } }).success,
    ).toBe(true);
  });

  it("refuses a kind whose `then` names nothing, unknown fields, and inverted guest bounds", () => {
    expect(RuleInputSchema.safeParse({ label: "x", kind: "hold", then: {} }).success).toBe(false);
    expect(
      RuleInputSchema.safeParse({ label: "x", kind: "route", then: { hold: "mkt" } }).success,
    ).toBe(false);
    expect(
      RuleInputSchema.safeParse({ label: "x", kind: "avail", then: { standard: true } }).success,
    ).toBe(false);
    expect(
      RuleInputSchema.safeParse({
        label: "x",
        kind: "route",
        when: { bogus: 1 },
        then: { route: "gs" },
      }).success,
    ).toBe(false);
    expect(
      RuleInputSchema.safeParse({
        label: "x",
        kind: "route",
        when: { guestsMin: 50, guestsMax: 10 },
        then: { route: "gs" },
      }).success,
    ).toBe(false);
    expect(
      RuleInputSchema.safeParse({ label: "", kind: "route", then: { route: "gs" } }).success,
    ).toBe(false);
    expect(
      RuleInputSchema.safeParse({ label: "x", kind: "route", then: { route: "Guest Services" } })
        .success,
    ).toBe(false);
  });

  it("defaults when/then to {} and trims the label", () => {
    const p = RuleInputSchema.parse({
      label: "  Std  ",
      kind: "standard",
      then: { standard: true },
    });
    expect(p.label).toBe("Std");
    expect(p.when).toEqual({});
  });
});

describe("RulesPostBodySchema", () => {
  it("upsert / toggle / reorder, ids numeric strings only", () => {
    expect(
      RulesPostBodySchema.safeParse({ action: "toggle", id: "3", enabled: false }).success,
    ).toBe(true);
    expect(
      RulesPostBodySchema.safeParse({ action: "toggle", id: "R3", enabled: false }).success,
    ).toBe(false);
    expect(RulesPostBodySchema.safeParse({ action: "reorder", ids: ["1", "2"] }).success).toBe(
      true,
    );
    expect(RulesPostBodySchema.safeParse({ action: "reorder", ids: [] }).success).toBe(false);
    expect(RulesPostBodySchema.safeParse({ action: "delete", id: "1" }).success).toBe(false);
  });
});

describe("TryLeadQuerySchema (query strings)", () => {
  it("coerces guests, accepts kids as 1/0/true/false, refuses junk", () => {
    const p = TryLeadQuerySchema.parse({
      guests: "42",
      type: "corporate",
      centre: "HPFM",
      kids: "1",
      eventDate: "2026-10-16",
    });
    expect(p).toEqual({
      guests: 42,
      type: "corporate",
      centre: "HPFM",
      kids: true,
      eventDate: "2026-10-16",
      source: undefined,
    });
    expect(
      TryLeadQuerySchema.parse({ guests: "1", type: "school", centre: "HPN", kids: "false" }).kids,
    ).toBe(false);
    expect(
      TryLeadQuerySchema.parse({ guests: "1", type: "school", centre: "HPN" }).kids,
    ).toBeUndefined();
    expect(
      TryLeadQuerySchema.safeParse({ guests: "0", type: "school", centre: "HPN" }).success,
    ).toBe(false);
    expect(
      TryLeadQuerySchema.safeParse({ guests: "9", type: "party", centre: "HPN" }).success,
    ).toBe(false);
    expect(
      TryLeadQuerySchema.safeParse({ guests: "9", type: "school", centre: "LOL" }).success,
    ).toBe(false);
    expect(
      TryLeadQuerySchema.safeParse({
        guests: "9",
        type: "school",
        centre: "HPN",
        eventDate: "10/16/2026",
      }).success,
    ).toBe(false);
  });
});

describe("RosterPostBodySchema", () => {
  it("repId numeric, off boolean, optional date and reason", () => {
    expect(RosterPostBodySchema.safeParse({ repId: "1", off: true }).success).toBe(true);
    expect(
      RosterPostBodySchema.safeParse({ repId: "1", off: true, date: "2026-09-12", reason: "PTO" })
        .success,
    ).toBe(true);
    expect(RosterPostBodySchema.safeParse({ repId: "kelsea", off: true }).success).toBe(false);
    expect(RosterPostBodySchema.safeParse({ repId: "1", off: "yes" }).success).toBe(false);
  });
});
