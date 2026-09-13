import { describe, expect, it } from "vitest";
import type { PublicRep } from "~/features/crm/core/contracts";
import type { AssignmentRule } from "~/features/crm/core/types";
import type { DecisionWire } from "~/features/crm/rules/contracts";
import {
  actionOf,
  delayOptions,
  formFromRule,
  kindOf,
  monthOptions,
  moveIndex,
  parseGuests,
  reorderByDrop,
  ruleCode,
  ruleFromForm,
  ruleThenLabel,
  ruleWhenLabel,
  traceRows,
} from "./model";

/** The pure half of the Rules screen: the prototype's when/then copy, the sheet's form ⇄ rule, ordering. */

const REPS: PublicRep[] = [
  {
    id: "4",
    slug: "gs",
    displayName: "Guest Services",
    firstName: "Guest Services",
    initials: "GS",
    role: "bucket",
    centres: ["HPFM", "FT", "HPN"],
  },
  {
    id: "5",
    slug: "mkt",
    displayName: "Marketing Director",
    firstName: "Marketing",
    initials: "MD",
    role: "hold",
    centres: ["HPFM", "FT", "HPN"],
  },
];
const CENTRES = [
  { code: "HPFM" as const, short: "HP Fort Myers" },
  { code: "FT" as const, short: "FastTrax" },
  { code: "HPN" as const, short: "HP Naples" },
];

const rule = (over: Partial<AssignmentRule>): AssignmentRule => ({
  id: "1",
  position: 1,
  enabled: true,
  kind: "hold",
  label: "Big groups go to Marketing",
  why: "Marketing Director holds any lead of 100+ guests",
  when: { guestsMin: 100 },
  then: { hold: "mkt" },
  ...over,
});

describe("ruleWhenLabel / ruleThenLabel (crm-shared.js:466-467)", () => {
  it("renders the seeded rules' pills verbatim", () => {
    expect(ruleWhenLabel({ guestsMin: 100 })).toBe("guests ≥ 100");
    expect(ruleWhenLabel({ type: "birthday", kids: true })).toBe("type = Birthday (kids)");
    expect(ruleWhenLabel({ type: "school", guestsMax: 39 })).toBe(
      "guests ≤ 39 and type = School / youth",
    );
    expect(ruleWhenLabel({})).toBe("any lead");
    expect(
      ruleWhenLabel({ centre: "FT", source: "referral", partyMonth: "2026-12" }, CENTRES),
    ).toBe("centre = FastTrax and source = Referral and party month = Dec 2026");
    expect(ruleThenLabel({ hold: "mkt" }, REPS)).toBe("hold for Marketing Director");
    expect(ruleThenLabel({ route: "gs" }, REPS)).toBe("route to Guest Services");
    expect(ruleThenLabel({ route: "ghost" }, REPS)).toBe("route to ghost");
    expect(ruleThenLabel({ skipOff: true }, REPS)).toBe("exclude reps marked off");
    expect(ruleThenLabel({ onShift: true }, REPS)).toBe("prefer on shift → next shift");
    expect(ruleThenLabel({ standard: true }, REPS)).toBe("lowest party-month volume");
    expect(ruleThenLabel({ queue: true }, REPS)).toBe("leave in queue");
    expect(ruleCode({ position: 7 })).toBe("R7");
  });
});

describe("ordering", () => {
  it("moveIndex swaps neighbours and refuses the ends; reorderByDrop inserts at the target slot", () => {
    expect(moveIndex(["1", "2", "3"], "2", -1)).toEqual(["2", "1", "3"]);
    expect(moveIndex(["1", "2", "3"], "3", 1)).toEqual(["1", "2", "3"]);
    expect(moveIndex(["1", "2", "3"], "9", 1)).toEqual(["1", "2", "3"]);
    expect(reorderByDrop(["1", "2", "3", "4"], "4", "2")).toEqual(["1", "4", "2", "3"]);
    expect(reorderByDrop(["1", "2", "3", "4"], "1", "3")).toEqual(["2", "3", "1", "4"]);
    expect(reorderByDrop(["1", "2", "3"], "2", "2")).toEqual(["1", "2", "3"]);
    expect(reorderByDrop(["1", "2", "3"], "x", "2")).toEqual(["1", "2", "3"]);
  });
});

describe("the sheet's form model", () => {
  it("actionOf / kindOf round-trip every kind, including the two availability flavours", () => {
    expect(actionOf(rule({ kind: "hold" }))).toBe("hold");
    expect(actionOf(rule({ kind: "route", then: { route: "gs" } }))).toBe("route");
    expect(actionOf(rule({ kind: "avail", then: { skipOff: true } }))).toBe("skipOff");
    expect(actionOf(rule({ kind: "avail", then: { onShift: true } }))).toBe("onShift");
    expect(actionOf(rule({ kind: "standard", then: { standard: true } }))).toBe("standard");
    expect(actionOf(rule({ kind: "fallback", then: { queue: true } }))).toBe("queue");
    expect(
      ["hold", "route", "standard", "queue", "skipOff", "onShift"].map((a) => kindOf(a as never)),
    ).toEqual(["hold", "route", "standard", "fallback", "avail", "avail"]);
  });

  it("formFromRule → ruleFromForm reproduces R1, R2 (kids kept), R4 and a new empty form", () => {
    const r1 = rule({});
    const f1 = formFromRule(r1, REPS);
    expect(f1).toMatchObject({
      label: r1.label,
      guestsMin: "100",
      guestsMax: "",
      action: "hold",
      person: "mkt",
    });
    expect(ruleFromForm(f1, "1")).toEqual({
      rule: {
        id: "1",
        label: r1.label,
        kind: "hold",
        why: r1.why,
        when: { guestsMin: 100 },
        then: { hold: "mkt" },
      },
    });

    const r2 = rule({
      id: "2",
      kind: "route",
      label: "Kids' birthdays to Guest Services",
      when: { type: "birthday", kids: true },
      then: { route: "gs" },
      why: null,
    });
    const f2 = formFromRule(r2, REPS);
    expect(f2.kids).toBe(true);
    expect(ruleFromForm(f2, "2")).toEqual({
      rule: {
        id: "2",
        label: r2.label,
        kind: "route",
        why: null,
        when: { type: "birthday", kids: true },
        then: { route: "gs" },
      },
    });

    const r4 = rule({ id: "4", kind: "avail", when: {}, then: { skipOff: true } });
    expect(ruleFromForm(formFromRule(r4, REPS), "4")).toEqual({
      rule: {
        id: "4",
        label: r4.label,
        kind: "avail",
        why: r4.why,
        when: {},
        then: { skipOff: true },
      },
    });

    const empty = formFromRule(undefined, REPS);
    expect(empty).toMatchObject({ label: "", action: "route", person: "gs" });
    expect(ruleFromForm(empty, undefined)).toEqual({ error: "A name is required." });
  });

  it("refuses junk numbers, inverted bounds and a person-less hold; kids is dropped when the type is not birthday", () => {
    const base = formFromRule(undefined, REPS);
    expect(ruleFromForm({ ...base, label: "x", guestsMin: "ten" }, undefined)).toEqual({
      error: "Guests at least must be a whole number.",
    });
    expect(
      ruleFromForm({ ...base, label: "x", guestsMin: "50", guestsMax: "10" }, undefined),
    ).toEqual({ error: "Guests at least cannot exceed guests at most." });
    expect(ruleFromForm({ ...base, label: "x", action: "hold", person: "" }, undefined)).toEqual({
      error: "Pick a person or team.",
    });
    const out = ruleFromForm(
      { ...base, label: "x", type: "school", kids: true, action: "standard" },
      undefined,
    );
    expect(out).toEqual({
      rule: {
        label: "x",
        kind: "standard",
        why: null,
        when: { type: "school" },
        then: { standard: true },
      },
    });
  });
});

describe("options", () => {
  it("monthOptions rolls over the year; delayOptions keeps an odd current value", () => {
    const m = monthOptions("2026-11-05", 4);
    expect(m).toEqual([
      { value: "2026-11", label: "Nov 2026" },
      { value: "2026-12", label: "Dec 2026" },
      { value: "2027-01", label: "Jan 2027" },
      { value: "2027-02", label: "Feb 2027" },
    ]);
    expect(delayOptions(60).map((o) => o.label)).toEqual(["60 minutes", "30 minutes", "2 hours"]);
    expect(delayOptions(45)[0]).toEqual({ value: 45, label: "45 minutes" });
  });

  it("parseGuests accepts whole numbers ≥ 1 only", () => {
    expect(parseGuests("42")).toBe(42);
    expect(parseGuests(" 7 ")).toBe(7);
    expect(parseGuests("0")).toBeNull();
    expect(parseGuests("4.5")).toBeNull();
    expect(parseGuests("")).toBeNull();
    expect(parseGuests("abc")).toBeNull();
  });

  it("traceRows shows the code as the visible id and the final code", () => {
    const d: DecisionWire = {
      rep: null,
      reason: "waits for Jacob",
      outcome: "queue",
      trace: [
        { ruleId: "1", code: "R1", label: "Big groups go to Marketing", hit: false },
        {
          ruleId: "7",
          code: "R7",
          label: "Otherwise wait for Jacob (60 min, then auto)",
          hit: true,
        },
      ],
      finalRuleId: "7",
      finalRuleCode: "R7",
    };
    expect(traceRows(d)).toEqual({
      steps: [
        { ruleId: "R1", hit: false, note: undefined, label: "Big groups go to Marketing" },
        {
          ruleId: "R7",
          hit: true,
          note: undefined,
          label: "Otherwise wait for Jacob (60 min, then auto)",
        },
      ],
      finalRuleId: "R7",
    });
  });
});
