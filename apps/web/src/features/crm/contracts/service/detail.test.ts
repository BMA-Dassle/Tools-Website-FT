import { describe, expect, it } from "vitest";
import { clientKeyForCenterCode, publicNotesFromProject, toLineItems } from "./detail";

/**
 * The pure half of the contract detail read. The Office and Square calls are
 * covered by `actions.test.ts`'s injected deps; what a test can hold here is
 * the SHAPE of what BMI hands back, which is the part that silently breaks.
 */

describe("publicNotesFromProject", () => {
  const publicLog = { public: true, kind: 1, memo: "Arrive 15 minutes early.", id: "9" };
  const privateLog = { public: false, kind: 1, memo: "Team mom paying.", id: "8" };

  it("reads the memo of the PUBLIC log, never the private one", () => {
    expect(publicNotesFromProject({ logs: [privateLog, publicLog] })).toBe(
      "Arrive 15 minutes early.",
    );
  });

  it("accepts the older `isPublic` spelling the same payload sometimes uses", () => {
    expect(publicNotesFromProject({ logs: [{ isPublic: true, memo: "Lanes 13–22." }] })).toBe(
      "Lanes 13–22.",
    );
  });

  it("a project with no public log reads null — never the private note by accident", () => {
    expect(publicNotesFromProject({ logs: [privateLog] })).toBeNull();
    expect(publicNotesFromProject({ logs: [] })).toBeNull();
    expect(publicNotesFromProject({})).toBeNull();
    expect(publicNotesFromProject(null)).toBeNull();
    expect(publicNotesFromProject("not a project")).toBeNull();
  });

  it("a truthy-but-not-true flag is NOT public — the guest note is not a place to guess", () => {
    expect(publicNotesFromProject({ logs: [{ public: "yes", memo: "leak" }] })).toBeNull();
    expect(publicNotesFromProject({ logs: [{ public: 1, memo: "leak" }] })).toBeNull();
  });

  it("an empty public memo is an empty string, which is different from 'no public log'", () => {
    expect(publicNotesFromProject({ logs: [{ public: true, memo: "" }] })).toBe("");
    expect(publicNotesFromProject({ logs: [{ public: true }] })).toBeNull();
  });
});

describe("clientKeyForCenterCode", () => {
  it("FT and HPFM share ONE Office tenant; Naples is its own", () => {
    expect(clientKeyForCenterCode("fort-myers")).toBe("headpinzftmyers");
    expect(clientKeyForCenterCode("fasttrax")).toBe("headpinzftmyers");
    expect(clientKeyForCenterCode("naples")).toBe("headpinznaples");
  });

  it("an unknown centre falls back to Fort Myers, as every other caller does", () => {
    expect(clientKeyForCenterCode("nowhere")).toBe("headpinzftmyers");
  });
});

describe("toLineItems", () => {
  it("converts the contract's DOLLAR line items to the CRM's cents", () => {
    expect(toLineItems([{ name: "Arcade Card", price: 10, qty: 85, total: 850 }])).toEqual([
      { name: "Arcade Card", qty: 85, unitCents: 1000, totalCents: 85_000 },
    ]);
  });

  it("derives the total when the row omits it, and survives a ragged row", () => {
    expect(toLineItems([{ name: "Lane block", price: 12.5, qty: 4 }])[0].totalCents).toBe(5_000);
    expect(toLineItems([{}])).toEqual([{ name: "Item", qty: 0, unitCents: 0, totalCents: 0 }]);
    expect(toLineItems(null)).toEqual([]);
    expect(toLineItems("nope")).toEqual([]);
  });

  it("rounds to whole cents rather than carrying a float into the money column", () => {
    expect(toLineItems([{ name: "Per head", price: 19.99, qty: 3 }])[0].totalCents).toBe(5_997);
  });
});
