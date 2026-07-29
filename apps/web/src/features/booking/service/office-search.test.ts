import { describe, expect, it } from "vitest";
import {
  descriptionMatchesLastName,
  dobTokenOf,
  firstNameAffinity,
  lastSeenFromDescription,
  nameFromDescription,
  rankSearchResults,
  scoreSearchResult,
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
    expect(dobTokenOf("2002-08-20")).toBe("8/20/2002");
    expect(dobTokenOf("1990-12-05")).toBe("12/5/1990");
    expect(dobTokenOf("2010-01-01")).toBe("1/1/2010");
  });
});

describe("descriptionMatchesLastName", () => {
  // Live shape from the combined-token search: "Alex Trepasso (8/20/2002)
  // zip: 33966 phone: 7249676207 Last seen: 7/22/2026 Memberships: …"
  const DESC_DOB = "JANE DOE (8/20/2002) zip: 33901 phone: 2395551212 Last seen: 7/22/2026";
  it("matches whole words case-insensitively", () => {
    expect(descriptionMatchesLastName(DESC_DOB, "doe")).toBe(true);
    expect(descriptionMatchesLastName(DESC_FULL, "DOE")).toBe(true);
  });
  it("does not match substrings of longer names", () => {
    expect(descriptionMatchesLastName("JANE DOEBER (8/20/2002)", "DOE")).toBe(false);
  });
  it("matches a nameless legacy record whose name part is just the last name", () => {
    expect(descriptionMatchesLastName(" DOE (8/20/2002) zip: 33973", "doe")).toBe(true);
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
