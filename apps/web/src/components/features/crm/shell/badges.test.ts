import { describe, expect, it } from "vitest";
import { leadsKeys } from "~/features/crm/leads/queries";
import { smsKeys } from "~/features/crm/sms/queries";
import { BADGE_PATHS, BADGE_SOURCES, badgeCountsFrom, badgeKeyFor } from "./badges";

/**
 * THE SIDEBAR BADGES — shell plumbing every CRM screen reads, so it gets a
 * guard of its own.
 *
 * Two things are pinned here because both were silently wrong at some point:
 *
 *   • the FAN-OUT. `useBadgeCounts` polls one query per PATH, not per badge, so
 *     two badges fed by `/leads/badges` cost one request. A PR that adds a
 *     badge fills its line in `BADGE_SOURCES` and nothing else — this asserts
 *     the folding across two different payload paths at once.
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

  it("a rep never sees the director-only unassigned count", () => {
    const out = badgeCountsFrom({ "/leads/badges": { overdue: 1, unassigned: 9 } }, "rep");
    expect(out.overdue).toEqual({ n: 1 });
    expect(out.unassigned).toBeUndefined();
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
});
