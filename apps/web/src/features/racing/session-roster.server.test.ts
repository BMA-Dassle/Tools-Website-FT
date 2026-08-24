import { describe, expect, it } from "vitest";
import {
  dropNullParticipants,
  participantsCacheKey,
  PARTICIPANTS_CACHE_TTL_SEC,
  rosterIsWorthCaching,
  rosterUpstreamQuery,
} from "./session-roster.server";
import type { Participant } from "@/lib/participant-contact";

const p = (personId: unknown): Participant => ({ personId }) as Participant;

describe("participantsCacheKey", () => {
  it("is the key every existing reader already greps for", () => {
    // Hard-coded on purpose: pov-codes, checkin-race-flags, the signage
    // check-in band and the scan lookup all build this string by hand. If this
    // ever changes, those change with it or they silently read nothing.
    expect(participantsCacheKey("LAB52GY480CJF", "58571827", true)).toBe(
      "pandora:participants:LAB52GY480CJF:58571827:R1",
    );
    expect(participantsCacheKey("LAB52GY480CJF", 58571827, false)).toBe(
      "pandora:participants:LAB52GY480CJF:58571827:R0",
    );
  });

  it("separates centers, so Naples cannot collide with Fort Myers", () => {
    // Naples runs its own BMI server and can mint the same numeric sessionId.
    expect(participantsCacheKey("PPTR5G2N0QXF7", "58571827", true)).not.toBe(
      participantsCacheKey("LAB52GY480CJF", "58571827", true),
    );
  });
});

describe("rosterUpstreamQuery", () => {
  it("ALWAYS pulls the unpaid superset", () => {
    // The cache holds one entry per (location, session, excludeRemoved) and
    // callers apply their own unpaid filter. A writer that stored the paid-only
    // slice would delete unpaid racers from every reader — and an unpaid racer
    // scanning at the desk would be told they are in no active session.
    expect(rosterUpstreamQuery(true)).toBe("excludeRemoved=true&excludeUnpaid=false");
    expect(rosterUpstreamQuery(false)).toBe("excludeRemoved=false&excludeUnpaid=false");
  });

  it("never emits excludeUnpaid=true, whatever the removed flag", () => {
    for (const removed of [true, false]) {
      expect(rosterUpstreamQuery(removed)).not.toContain("excludeUnpaid=true");
    }
  });
});

describe("dropNullParticipants", () => {
  it("drops Pandora's all-null filler rows", () => {
    expect(dropNullParticipants([p("123"), p(null), p(undefined), p("456")])).toHaveLength(2);
  });

  it("drops the empty and whitespace-only personId", () => {
    expect(dropNullParticipants([p(""), p("   "), p("789")])).toHaveLength(1);
  });

  it("drops the DRIVER 1 PLACEHOLDER seat", () => {
    // An unassigned seat is not a person. Counting it inflates the grid, so
    // "all here" could never fire on a heat that had one.
    const out = dropNullParticipants([p("17750277"), p("999")]);
    expect(out).toHaveLength(1);
    expect(String(out[0].personId)).toBe("999");
  });

  it("keeps a numeric personId", () => {
    expect(dropNullParticipants([p(123456)])).toHaveLength(1);
  });
});

describe("rosterIsWorthCaching", () => {
  it("refuses to store an empty roster over a real one", () => {
    // A degraded upstream and an unbooked heat look identical here. Writing the
    // empty list would turn a bad minute into ten minutes of a scan lookup that
    // finds nobody.
    expect(rosterIsWorthCaching([])).toBe(false);
    expect(rosterIsWorthCaching([p("1")])).toBe(true);
  });
});

describe("PARTICIPANTS_CACHE_TTL_SEC", () => {
  it("outlives a called heat so an outage cannot empty the lookup", () => {
    expect(PARTICIPANTS_CACHE_TTL_SEC).toBe(600);
  });
});
