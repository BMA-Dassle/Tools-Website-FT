import { describe, expect, it } from "vitest";
import {
  collapseSearchHits,
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

describe("collapseSearchHits", () => {
  it("collapses duplicate records of one human to the most recent (live shape)", () => {
    const out = collapseSearchHits(DUPES, "DOE", "2002-08-20", "ALEXANDER");
    expect(out.map((h) => h.id)).toEqual(["1"]);
  });

  it("prefers a waiver-carrying duplicate over a more recent one without", () => {
    const out = collapseSearchHits(
      [
        hit({ id: "recent-no-waiver", lastVisit: "2026-07-01T00:00:00Z" }),
        hit({ id: "older-valid", waiverExpiry: FUTURE, lastVisit: "2026-01-01T00:00:00Z" }),
      ],
      "Doe",
      "2002-08-20",
    );
    expect(out.map((h) => h.id)).toEqual(["older-valid"]);
  });

  it("guards on exact last name + DOB (case-insensitive name)", () => {
    const out = collapseSearchHits(
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

  it("keeps twins (distinct first names) separate, scanned name first", () => {
    const out = collapseSearchHits(
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

  it("drops nameless records when a named one matched, keeps one when alone", () => {
    const withNamed = collapseSearchHits(
      [hit({ id: "named" }), hit({ id: "nameless", firstName: null })],
      "Doe",
      "2002-08-20",
    );
    expect(withNamed.map((h) => h.id)).toEqual(["named"]);

    const alone = collapseSearchHits(
      [
        hit({ id: "nameless-1", firstName: null }),
        hit({ id: "nameless-2", firstName: null, waiverExpiry: FUTURE }),
      ],
      "Doe",
      "2002-08-20",
    );
    expect(alone.map((h) => h.id)).toEqual(["nameless-2"]); // waiver-valid preferred
  });

  it("returns [] when nothing matches", () => {
    expect(collapseSearchHits([], "Doe", "2002-08-20")).toEqual([]);
    expect(collapseSearchHits([hit({ lastName: "Smith" })], "Doe", "2002-08-20")).toEqual([]);
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
