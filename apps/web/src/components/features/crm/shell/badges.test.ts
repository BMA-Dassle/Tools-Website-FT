import { describe, expect, it } from "vitest";
import { NAV_GROUPS, MORE_ITEMS, PHONE_TABS, type BadgeKey } from "~/features/crm/core/nav";
import { BADGE_PATHS, BADGE_SOURCES, badgeCountsFrom } from "./badges";

/**
 * The badge table each PR fills one line of. What this pins is the contract
 * between `core/nav.ts` (which NAMES a badge) and this table (which says where
 * the count comes from) — the failure mode otherwise is a badge that silently
 * never appears.
 */

describe("BADGE_SOURCES", () => {
  it("has an entry for every badge the nav names", () => {
    const named = new Set<BadgeKey>();
    for (const g of NAV_GROUPS) for (const i of g.items) if (i.badge) named.add(i.badge);
    for (const i of [...PHONE_TABS, ...MORE_ITEMS]) if (i.badge) named.add(i.badge);
    for (const key of named) {
      expect(Object.hasOwn(BADGE_SOURCES, key), key).toBe(true);
    }
  });

  it("names the Calls badge's own endpoint (C3's line)", () => {
    expect(BADGE_SOURCES.missedCalls).toEqual({
      path: "/calls/badges",
      field: "missedCalls",
      soft: true,
    });
    expect(BADGE_PATHS).toContain("/calls/badges");
  });

  it("lists each distinct path once, so the hook polls each endpoint once", () => {
    expect(BADGE_PATHS.length).toBe(new Set(BADGE_PATHS).size);
  });
});

describe("badgeCountsFrom", () => {
  const payloads = {
    "/leads/badges": { overdue: 3, unassigned: 2 },
    "/calls/badges": { missedCalls: 4 },
  };

  it("folds every path's payload into one count map", () => {
    expect(badgeCountsFrom(payloads, "director")).toEqual({
      overdue: { n: 3 },
      unassigned: { n: 2 },
      missedCalls: { n: 4, soft: true },
    });
  });

  it("hides the director-only count from a rep, but shows them missed calls", () => {
    const out = badgeCountsFrom(payloads, "rep");
    expect(out.unassigned).toBeUndefined();
    expect(out.missedCalls).toEqual({ n: 4, soft: true });
  });

  it("shows no badge for a zero, and none for an endpoint that did not answer", () => {
    expect(
      badgeCountsFrom({ "/calls/badges": { missedCalls: 0 } }, "rep").missedCalls,
    ).toBeUndefined();
    expect(badgeCountsFrom({}, "rep")).toEqual({});
    expect(badgeCountsFrom({ "/calls/badges": undefined }, "rep")).toEqual({});
  });

  it("ignores a value that is not a finite number rather than rendering NaN", () => {
    expect(
      badgeCountsFrom({ "/calls/badges": { missedCalls: "lots" } }, "rep").missedCalls,
    ).toBeUndefined();
  });
});
