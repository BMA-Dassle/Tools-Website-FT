import { describe, expect, it } from "vitest";
import { BADGE_PATHS, BADGE_SOURCES, badgeCountsFrom, pickField } from "./badges";

/**
 * The badge table: which endpoint each sidebar count comes from, and the fold
 * into `BadgeCounts`. B5 fills the `pendingApproval` line, which is the first
 * one to read a NESTED field — the contracts board answers one envelope for
 * its tiles and its badge, so the badge poll does not cost a page of contracts
 * a minute.
 */
describe("BADGE_SOURCES", () => {
  it("names an endpoint for every badge a PR has shipped, and null for the rest", () => {
    expect(BADGE_SOURCES.overdue).toEqual({ path: "/leads/badges", field: "overdue" });
    expect(BADGE_SOURCES.unassigned).toEqual({ path: "/leads/badges", field: "unassigned" });
    expect(BADGE_SOURCES.pendingApproval).toEqual({
      path: "/contracts?counts=1",
      field: "counts.pendingApproval",
    });
    expect(BADGE_SOURCES.unread).toBeNull();
  });

  it("polls each distinct endpoint once", () => {
    expect([...BADGE_PATHS].sort()).toEqual(["/contracts?counts=1", "/leads/badges"]);
  });
});

describe("pickField", () => {
  it("reads a plain field and a dotted one", () => {
    expect(pickField({ overdue: 3 }, "overdue")).toBe(3);
    expect(pickField({ counts: { pendingApproval: 2 } }, "counts.pendingApproval")).toBe(2);
  });

  it("gives up quietly on a missing path rather than throwing on a slow first load", () => {
    expect(pickField(undefined, "counts.pendingApproval")).toBeUndefined();
    expect(pickField({}, "counts.pendingApproval")).toBeUndefined();
    expect(pickField({ counts: null }, "counts.pendingApproval")).toBeUndefined();
    expect(pickField({ counts: 7 }, "counts.pendingApproval")).toBeUndefined();
  });
});

describe("badgeCountsFrom", () => {
  const payloads = {
    "/leads/badges": { ok: true, overdue: 4, unassigned: 2 },
    "/contracts?counts=1": { ok: true, counts: { pendingApproval: 3, attention: 9 } },
  };

  it("folds every source for a director", () => {
    expect(badgeCountsFrom(payloads, "director")).toEqual({
      overdue: { n: 4 },
      unassigned: { n: 2 },
      pendingApproval: { n: 3 },
    });
  });

  it("a rep never sees the unassigned count — they cannot open the queue", () => {
    expect(badgeCountsFrom(payloads, "rep")).toEqual({
      overdue: { n: 4 },
      pendingApproval: { n: 3 },
    });
  });

  it("zero renders NO badge, and a missing payload is zero", () => {
    expect(
      badgeCountsFrom(
        { "/leads/badges": { overdue: 0, unassigned: 0 }, "/contracts?counts=1": undefined },
        "director",
      ),
    ).toEqual({});
  });

  it("a non-numeric value is not trusted into the UI", () => {
    expect(
      badgeCountsFrom({ "/contracts?counts=1": { counts: { pendingApproval: "3" } } }, "director"),
    ).toEqual({});
  });
});
