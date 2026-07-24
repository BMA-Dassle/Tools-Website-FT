import { describe, expect, it } from "vitest";
import {
  filterAndRankHits,
  firstNameAffinity,
  hitWaiverValid,
  type PandoraSearchHit,
} from "./search-hits";

const hit = (over: Partial<PandoraSearchHit>): PandoraSearchHit => ({
  id: "63000000000000001",
  firstName: "Alex",
  lastName: "Doe",
  birthdate: "2002-08-20T04:00:00.000Z",
  waiverExpiry: null,
  lastVisit: null,
  ...over,
});

const FUTURE = "2030-01-01T10:00:00.000Z";
const PAST = "2020-01-01T10:00:00.000Z";

/** Mirrors the live 2026-07-23 result shape: one human, four duplicate
 *  records ordered lastVisit-desc, one legacy record with firstName null. */
const DUPES: PandoraSearchHit[] = [
  hit({ id: "1", waiverExpiry: FUTURE, lastVisit: "2026-07-07T23:04:23.978Z" }),
  hit({ id: "2", waiverExpiry: FUTURE, lastVisit: "2026-05-24T04:46:42.969Z" }),
  hit({ id: "3", firstName: null, lastVisit: "2023-11-15T20:16:49.148Z" }),
  hit({ id: "4" }),
];

describe("hitWaiverValid", () => {
  it("future expiry = valid; past/absent/garbage = not", () => {
    expect(hitWaiverValid(hit({ waiverExpiry: FUTURE }))).toBe(true);
    expect(hitWaiverValid(hit({ waiverExpiry: PAST }))).toBe(false);
    expect(hitWaiverValid(hit({ waiverExpiry: null }))).toBe(false);
    expect(hitWaiverValid(hit({ waiverExpiry: "not a date" }))).toBe(false);
  });
});

describe("filterAndRankHits", () => {
  it("keeps EVERY duplicate record (live 4-dupe shape) — named ones first, search order kept", () => {
    const out = filterAndRankHits(DUPES, "DOE", "2002-08-20", "ALEXANDER");
    // Named dupes keep their most-recent-first order; the nameless legacy
    // record (affinity 0) sinks to the end — but is still SHOWN.
    expect(out.map((h) => h.id)).toEqual(["1", "2", "4", "3"]);
  });

  it("guards on exact last name + DOB (case-insensitive name)", () => {
    const out = filterAndRankHits(
      [
        hit({ id: "wrong-dob", birthdate: "2001-08-20T04:00:00.000Z" }),
        hit({ id: "wrong-last", lastName: "Doeber" }),
        hit({ id: "right", lastName: "DOE" }),
      ],
      "doe",
      "2002-08-20",
    );
    expect(out.map((h) => h.id)).toEqual(["right"]);
  });

  it("ranks twins (distinct first names) by scanned-name affinity", () => {
    const out = filterAndRankHits(
      [
        hit({ id: "sam", firstName: "Sam", lastVisit: "2026-07-01T00:00:00Z" }),
        hit({ id: "alex", firstName: "Alex", lastVisit: "2026-01-01T00:00:00Z" }),
      ],
      "Doe",
      "2002-08-20",
      "ALEXANDER",
    );
    expect(out.map((h) => h.id)).toEqual(["alex", "sam"]);
  });

  it("without a scanned first name, the search's own order is preserved", () => {
    const out = filterAndRankHits(
      [hit({ id: "first" }), hit({ id: "second" })],
      "Doe",
      "2002-08-20",
    );
    expect(out.map((h) => h.id)).toEqual(["first", "second"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterAndRankHits([], "Doe", "2002-08-20")).toEqual([]);
    expect(filterAndRankHits([hit({ lastName: "Smith" })], "Doe", "2002-08-20")).toEqual([]);
  });
});

describe("firstNameAffinity", () => {
  it("exact > prefix > none; empty never matches", () => {
    expect(firstNameAffinity("Alex", "alex")).toBe(2);
    expect(firstNameAffinity("Alex", "ALEXANDER")).toBe(1);
    expect(firstNameAffinity("Sam", "Alexander")).toBe(0);
    expect(firstNameAffinity(null, "Alexander")).toBe(0);
    expect(firstNameAffinity("Alex", "")).toBe(0);
  });
});
