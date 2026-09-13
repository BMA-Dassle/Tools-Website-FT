import { describe, expect, it } from "vitest";
import { NAV_GROUPS, MORE_ITEMS, PHONE_TABS, type BadgeKey } from "~/features/crm/core/nav";
import { leadsKeys } from "~/features/crm/leads/queries";
import { smsKeys } from "~/features/crm/sms/queries";
import { BADGE_PATHS, BADGE_SOURCES, badgeCountsFrom, badgeKeyFor, pickField } from "./badges";

/**
 * THE SIDEBAR BADGES — shell plumbing every CRM screen reads, so it gets a
 * guard of its own.
 *
 * Three things are pinned here, each because it was silently wrong at some
 * point:
 *
 *   • the CONTRACT between `core/nav.ts` (which NAMES a badge) and this table
 *     (which says where the count comes from) — the failure mode otherwise is
 *     a badge that silently never appears.
 *   • the FAN-OUT. `useBadgeCounts` polls one query per PATH, not per badge, so
 *     two badges fed by `/leads/badges` cost one request. A PR that adds a
 *     badge fills its line in `BADGE_SOURCES` and nothing else — this asserts
 *     the folding across several payload paths at once.
 *   • the QUERY KEYS. A badge must live under its owning sub's key or the
 *     sub's own `invalidateQueries` misses it: reading a conversation
 *     invalidates `smsKeys.all` and the Messages badge kept its stale count for
 *     up to a minute because it was keyed `["crm","badges","/sms/unread"]`.
 */

describe("badgeKeyFor", () => {
  it("puts each badge under the key of the sub that changes it", () => {
    expect(badgeKeyFor("/leads/badges")).toEqual(leadsKeys.badges());
    // Under ["crm","sms"], so `invalidateQueries({queryKey: smsKeys.all})`
    // after a read or a send refreshes the badge immediately.
    expect(badgeKeyFor("/sms/unread")).toEqual(smsKeys.unread());
    expect(badgeKeyFor("/sms/unread").slice(0, 2)).toEqual(smsKeys.all);
  });

  it("anything without an owning sub still gets a stable key of its own", () => {
    expect(badgeKeyFor("/contracts/badges")).toEqual(["crm", "badges", "/contracts/badges"]);
    expect(badgeKeyFor("/calls/badges")).toEqual(["crm", "badges", "/calls/badges"]);
  });
});

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

  it("names the Messages badge's own endpoint (C1's line)", () => {
    expect(BADGE_SOURCES.unread).toEqual({ path: "/sms/unread", field: "n", soft: true });
    expect(BADGE_PATHS).toContain("/sms/unread");
  });

  it("names the Contracts badge's own endpoint (B5's line), the first NESTED field", () => {
    expect(BADGE_SOURCES.pendingApproval).toEqual({
      path: "/contracts?counts=1",
      field: "counts.pendingApproval",
    });
    expect(BADGE_PATHS).toContain("/contracts?counts=1");
  });

  it("lists each distinct path once, so the hook polls each endpoint once", () => {
    expect(BADGE_PATHS.length).toBe(new Set(BADGE_PATHS).size);
  });
});

/**
 * B5's line is the first to read a NESTED field: the contracts board answers
 * one envelope for its tiles AND its badge, so a badge poll must not cost a
 * page of contracts a minute just to reshape the JSON.
 */
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

describe("BADGE_PATHS", () => {
  it("is one entry per distinct endpoint — two leads badges are one request", () => {
    expect(BADGE_SOURCES.overdue?.path).toBe("/leads/badges");
    expect(BADGE_SOURCES.unassigned?.path).toBe("/leads/badges");
    expect(BADGE_PATHS.filter((p) => p === "/leads/badges")).toHaveLength(1);
    expect(BADGE_PATHS).toContain("/sms/unread");
    expect(new Set(BADGE_PATHS).size).toBe(BADGE_PATHS.length);
  });

  it("names no endpoint that no badge reads", () => {
    const declared = new Set(
      Object.values(BADGE_SOURCES)
        .filter((s) => s !== null)
        .map((s) => s!.path),
    );
    for (const path of BADGE_PATHS) expect(declared.has(path)).toBe(true);
  });
});

describe("badgeCountsFrom", () => {
  const payloads = {
    "/leads/badges": { overdue: 3, unassigned: 2 },
    "/calls/badges": { missedCalls: 4 },
  };

  it("folds two payload paths into one set of counts", () => {
    const out = badgeCountsFrom(
      { "/leads/badges": { overdue: 3, unassigned: 2 }, "/sms/unread": { n: 5 } },
      "director",
    );
    expect(out.overdue).toEqual({ n: 3 });
    expect(out.unassigned).toEqual({ n: 2 });
    // A waiting message is not an SLA breach — the soft (muted) badge.
    expect(out.unread).toEqual({ n: 5, soft: true });
  });

  it("folds every path's payload into one count map", () => {
    expect(badgeCountsFrom(payloads, "director")).toEqual({
      overdue: { n: 3 },
      unassigned: { n: 2 },
      missedCalls: { n: 4, soft: true },
    });
  });

  it("a rep never sees the director-only unassigned count", () => {
    const out = badgeCountsFrom({ "/leads/badges": { overdue: 1, unassigned: 9 } }, "rep");
    expect(out.overdue).toEqual({ n: 1 });
    expect(out.unassigned).toBeUndefined();
  });

  it("hides the director-only count from a rep, but shows them missed calls", () => {
    const out = badgeCountsFrom(payloads, "rep");
    expect(out.unassigned).toBeUndefined();
    expect(out.missedCalls).toEqual({ n: 4, soft: true });
  });

  it("zero, missing and non-numeric all render NO badge — never a '0' pill", () => {
    expect(badgeCountsFrom({ "/leads/badges": { overdue: 0 }, "/sms/unread": {} }, "rep")).toEqual(
      {},
    );
    // One endpoint still loading must not blank the other's badge.
    expect(
      badgeCountsFrom({ "/leads/badges": undefined, "/sms/unread": { n: 2 } }, "rep").unread,
    ).toEqual({ n: 2, soft: true });
    expect(badgeCountsFrom({ "/sms/unread": { n: "lots" } }, "rep")).toEqual({});
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
