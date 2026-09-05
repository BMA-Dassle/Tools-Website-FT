import { describe, expect, it } from "vitest";
import {
  descriptionMatchesLastName,
  dobTokenOf,
  firstNameAffinity,
  lastSeenFromDescription,
  membershipsFromDescription,
  nameFromDescription,
  rankSearchResults,
  scoreSearchResult,
  substanceTier,
} from "./office-search";

const DESC_FULL = "JANE DOE (239) 555-1212 zip: 33901 Last seen: 3/1/2024";
const DESC_BARE = "JANE DOE";
const DESC_PHONE = "JANE DOE phone: 2395551212";

describe("nameFromDescription", () => {
  it("strips phone / zip / last-seen suffixes", () => {
    expect(nameFromDescription(DESC_FULL)).toBe("JANE DOE");
    expect(nameFromDescription(DESC_PHONE)).toBe("JANE DOE");
    expect(nameFromDescription(DESC_BARE)).toBe("JANE DOE");
  });
});

describe("scoreSearchResult / lastSeenFromDescription", () => {
  it("richer descriptions score higher", () => {
    expect(scoreSearchResult(DESC_FULL)).toBeGreaterThan(scoreSearchResult(DESC_BARE));
  });
  it("parses the last-seen date, 0 when absent", () => {
    expect(lastSeenFromDescription(DESC_FULL)).toBe(new Date("3/1/2024").getTime());
    expect(lastSeenFromDescription(DESC_BARE)).toBe(0);
  });
});

describe("dobTokenOf", () => {
  it("strips leading zeros — the only form the Office search matches", () => {
    expect(dobTokenOf("2001-03-14")).toBe("3/14/2001");
    expect(dobTokenOf("1990-12-05")).toBe("12/5/1990");
    expect(dobTokenOf("2010-01-01")).toBe("1/1/2010");
  });
});

describe("descriptionMatchesLastName", () => {
  // Mirrors the live combined-token search shape (name/DOB fictionalized):
  // "JANE DOE (3/14/2001) zip: 33901 phone: … Last seen: 7/22/2026 Memberships: …"
  const DESC_DOB = "JANE DOE (3/14/2001) zip: 33901 phone: 2395551212 Last seen: 7/22/2026";
  it("matches whole words case-insensitively", () => {
    expect(descriptionMatchesLastName(DESC_DOB, "doe")).toBe(true);
    expect(descriptionMatchesLastName(DESC_FULL, "DOE")).toBe(true);
  });
  it("does not match substrings of longer names", () => {
    expect(descriptionMatchesLastName("JANE DOEBER (3/14/2001)", "DOE")).toBe(false);
  });
  it("matches a nameless legacy record whose name part is just the last name", () => {
    expect(descriptionMatchesLastName(" DOE (3/14/2001) zip: 33973", "doe")).toBe(true);
  });
  it("matches inside hyphenated names; rejects empty needles", () => {
    expect(descriptionMatchesLastName("ANA SMITH-JONES (1/2/2003)", "SMITH")).toBe(true);
    expect(descriptionMatchesLastName(DESC_DOB, "  ")).toBe(false);
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

describe("rankSearchResults", () => {
  it("dedupes by localId, then by name keeping the most recent copy", () => {
    const ranked = rankSearchResults(
      [
        { localId: "1", description: "JANE DOE Last seen: 1/1/2020" },
        { localId: "1", description: "JANE DOE Last seen: 1/1/2020" }, // dup id
        { localId: "2", description: "JANE DOE (239) 555-1212 Last seen: 3/1/2024" }, // same name, newer
        { localId: "3", description: "BOB SMITH Last seen: 6/1/2023" },
      ],
      10,
    );
    expect(ranked.map((r) => r.localId)).toEqual(["2", "3"]);
  });

  it("breaks last-seen ties on description completeness", () => {
    const ranked = rankSearchResults(
      [
        { localId: "a", description: "JANE DOE Last seen: 3/1/2024" },
        { localId: "b", description: "JANE DOE (239) 555-1212 zip: 33901 Last seen: 3/1/2024" },
      ],
      10,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].localId).toBe("b");
  });

  it("orders most-recent-first and honors the cap", () => {
    const ranked = rankSearchResults(
      [
        { localId: "old", description: "A ONE Last seen: 1/1/2020" },
        { localId: "new", description: "B TWO Last seen: 1/1/2025" },
        { localId: "mid", description: "C THREE Last seen: 1/1/2023" },
      ],
      2,
    );
    expect(ranked.map((r) => r.localId)).toEqual(["new", "mid"]);
  });
});

// ── substance ranking ───────────────────────────────────────────────────────
// Shapes copied from a live `search/person` answer (names/DOBs fictionalized).
// This is the case that broke the phone sign-in: one number on hundreds of
// records, the real account old, every recent duplicate a value-less stub.
const REAL_ACCOUNT =
  "JANE DOE (3/14/2001) zip: 33901 phone: 2395551212, 2395551212 Last seen: 7/1/2026 " +
  "Memberships: Default, Default Membership, Customer Registration, License Fee, Turbo Pass, " +
  "Qualified Intermediate, Qualified Pro";
const RECENT_STUB = "JANE DOE phone: 2395551212 Last seen: 8/22/2026";
const REGISTERED_STUB =
  "WEB USER (1/1/1990) phone: 2395551212 Last seen: 8/13/2026 Memberships: Customer Registration";

describe("membershipsFromDescription", () => {
  it("splits the Memberships tail; empty when absent", () => {
    expect(membershipsFromDescription(REAL_ACCOUNT)).toEqual([
      "Default",
      "Default Membership",
      "Customer Registration",
      "License Fee",
      "Turbo Pass",
      "Qualified Intermediate",
      "Qualified Pro",
    ]);
    expect(membershipsFromDescription(RECENT_STUB)).toEqual([]);
  });
});

describe("substanceTier", () => {
  it("2 for racing value, 1 for an identified human, 0 for a bare stub", () => {
    expect(substanceTier(REAL_ACCOUNT)).toBe(2);
    expect(substanceTier("JANE DOE (3/14/2001) phone: 2395551212")).toBe(1);
    expect(substanceTier("JANE DOE zip: 33901 phone: 2395551212")).toBe(1);
    expect(substanceTier(RECENT_STUB)).toBe(0);
  });

  it("the auto-granted memberships are NOT substance", () => {
    // "Customer Registration" / "Default Membership" ride along on every
    // web-registered stub, so on their own they must not lift a record.
    expect(substanceTier(REGISTERED_STUB)).toBe(1); // the DOB, not the membership
    expect(substanceTier("WEB USER phone: 2395551212 Memberships: Customer Registration")).toBe(0);
    expect(substanceTier("WEB USER phone: 2395551212 Memberships: Default Membership")).toBe(0);
  });
});

describe("rankSearchResults — substance beats recency", () => {
  it("surfaces the licensed account over newer value-less duplicates", () => {
    // Distinct names so nothing collapses — this asserts the ORDER only.
    const ranked = rankSearchResults(
      [
        { localId: "stub-newest", description: RECENT_STUB.replace("JANE DOE", "JAN DOE") },
        { localId: "stub-registered", description: REGISTERED_STUB },
        { localId: "real", description: REAL_ACCOUNT },
      ],
      10,
    );
    expect(ranked[0].localId).toBe("real");
    expect(ranked.map((r) => r.tier)).toEqual([2, 1, 0]);
  });

  it("keeps the SUBSTANTIVE copy when duplicates share a name, not the newest", () => {
    // The bug in one assertion: collapsing by name on recency alone threw the
    // real account away before the ordering could ever surface it.
    const ranked = rankSearchResults(
      [
        { localId: "stub-newest", description: RECENT_STUB },
        { localId: "real", description: REAL_ACCOUNT },
      ],
      10,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].localId).toBe("real");
  });

  it("still prefers the most recent copy among records of equal substance", () => {
    // The owner's 2026-07-21 rule, intact where it belongs.
    const ranked = rankSearchResults(
      [
        { localId: "older", description: REAL_ACCOUNT },
        {
          localId: "newer",
          description: REAL_ACCOUNT.replace("Last seen: 7/1/2026", "Last seen: 9/1/2026"),
        },
      ],
      10,
    );
    expect(ranked[0].localId).toBe("newer");
  });

  it("a parenthesised area code is not a birthdate", () => {
    // `(\d` used to match "(239) 555-1212" and score it as a DOB.
    expect(substanceTier("JANE DOE (239) 555-1212")).toBe(0);
    expect(scoreSearchResult("JANE DOE (239) 555-1212")).toBe(0);
  });
});
