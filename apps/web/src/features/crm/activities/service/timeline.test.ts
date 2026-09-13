import { describe, expect, it } from "vitest";
import type { CrmActivity } from "../../core/types";
import {
  buildTimeline,
  externalIdentity,
  mergeTimeline,
  sortTimeline,
  touchesFrom,
} from "./timeline";

/**
 * The merge is what later PRs plug into: B5 adds the contract audit log and
 * the Square timeline, B6 the BMI note sections. What has to hold now, so it
 * still holds then: newest first, deterministic ties, and ONE row per
 * `(external_kind, external_ref)` — the same identity the unique index on
 * `crm_activities` enforces, so a webhook that was already mirrored into the
 * table cannot appear twice on screen.
 */

function act(over: Partial<CrmActivity> & Pick<CrmActivity, "id" | "occurredAt">): CrmActivity {
  return {
    leadId: "1042",
    contactId: null,
    repId: null,
    actorEmail: null,
    kind: "note",
    direction: null,
    durationSeconds: null,
    outcome: null,
    subject: null,
    body: null,
    externalKind: null,
    externalRef: null,
    meta: null,
    ...over,
  };
}

describe("sortTimeline", () => {
  it("puts the newest first", () => {
    const sorted = sortTimeline([
      act({ id: "1", occurredAt: "2026-09-10T12:00:00.000Z" }),
      act({ id: "2", occurredAt: "2026-09-12T12:00:00.000Z" }),
      act({ id: "3", occurredAt: "2026-09-11T12:00:00.000Z" }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["2", "3", "1"]);
  });

  it("breaks a same-millisecond tie by id descending, deterministically", () => {
    const same = "2026-09-12T12:00:00.000Z";
    const a = sortTimeline([
      act({ id: "7", occurredAt: same }),
      act({ id: "9", occurredAt: same }),
      act({ id: "8", occurredAt: same }),
    ]);
    const b = sortTimeline([
      act({ id: "8", occurredAt: same }),
      act({ id: "7", occurredAt: same }),
      act({ id: "9", occurredAt: same }),
    ]);
    expect(a.map((x) => x.id)).toEqual(["9", "8", "7"]);
    expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id));
  });

  it("sorts numerically, not lexically — id 10 is newer than id 9", () => {
    const same = "2026-09-12T12:00:00.000Z";
    expect(
      sortTimeline([act({ id: "9", occurredAt: same }), act({ id: "10", occurredAt: same })]).map(
        (a) => a.id,
      ),
    ).toEqual(["10", "9"]);
  });

  it("does not mutate its input", () => {
    const input = [
      act({ id: "1", occurredAt: "2026-09-10T12:00:00.000Z" }),
      act({ id: "2", occurredAt: "2026-09-12T12:00:00.000Z" }),
    ];
    sortTimeline(input);
    expect(input.map((a) => a.id)).toEqual(["1", "2"]);
  });
});

describe("mergeTimeline", () => {
  it("drops a duplicate external ref, keeping the row from the FIRST source", () => {
    const stored = act({
      id: "1",
      occurredAt: "2026-09-12T12:00:00.000Z",
      kind: "payment",
      externalKind: "square",
      externalRef: "pay_abc",
      body: "stored",
    });
    const mirrored = act({
      id: "99",
      occurredAt: "2026-09-12T12:00:00.000Z",
      kind: "payment",
      externalKind: "square",
      externalRef: "pay_abc",
      body: "from the other source",
    });
    const out = mergeTimeline([[stored], [mirrored]]);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("stored");
  });

  it("keeps two rows that share a ref but not a kind", () => {
    const a = act({
      id: "1",
      occurredAt: "2026-09-12T12:00:00Z",
      externalKind: "square",
      externalRef: "x",
    });
    const b = act({
      id: "2",
      occurredAt: "2026-09-12T13:00:00Z",
      externalKind: "vox",
      externalRef: "x",
    });
    expect(mergeTimeline([[a], [b]])).toHaveLength(2);
  });

  it("never collapses rows that have no external ref", () => {
    const a = act({ id: "1", occurredAt: "2026-09-12T12:00:00Z", body: "one note" });
    const b = act({ id: "2", occurredAt: "2026-09-12T12:30:00Z", body: "another note" });
    expect(mergeTimeline([[a, b]])).toHaveLength(2);
    expect(externalIdentity(a)).toBeNull();
  });

  it("drops a row repeated by id within one source", () => {
    const a = act({ id: "1", occurredAt: "2026-09-12T12:00:00Z" });
    expect(mergeTimeline([[a, a]])).toHaveLength(1);
  });
});

describe("buildTimeline", () => {
  it("passes the page cursor through untouched", () => {
    const page = {
      activities: [act({ id: "2", occurredAt: "2026-09-12T12:00:00Z" })],
      nextCursor: "2026-09-12T12:00:00.000Z|2",
    };
    expect(buildTimeline(page).nextCursor).toBe("2026-09-12T12:00:00.000Z|2");
  });
});

describe("touchesFrom", () => {
  const now = new Date("2026-09-13T01:30:00.000Z"); // 9:30 PM ET on Sep 12

  it("counts only TODAY's ET touches from an already-loaded page", () => {
    const counts = touchesFrom(
      [
        act({ id: "1", occurredAt: "2026-09-13T01:00:00Z", kind: "call", direction: "out" }),
        act({ id: "2", occurredAt: "2026-09-12T18:00:00Z", kind: "call", direction: "out" }),
        act({ id: "3", occurredAt: "2026-09-12T18:05:00Z", kind: "sms", direction: "out" }),
        // Yesterday in ET — does not count towards today.
        act({ id: "4", occurredAt: "2026-09-11T18:00:00Z", kind: "email", direction: "out" }),
      ],
      now,
    );
    expect(counts).toEqual({ call: 1, sms: 1, email: 0, reachout: 0 });
  });
});
