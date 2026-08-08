import { describe, expect, it } from "vitest";
import {
  isPlaceholderName,
  joinWasRemovedFromBmi,
  mergeRosterRows,
  normalizeName,
  type RosterRow,
} from "./roster-merge";

const bmi = (full: string, personId: string): RosterRow => ({
  full,
  personId,
  source: "bmi-project",
});
const label = (full: string): RosterRow => ({ full, personId: null, source: "booking-label" });
const join = (full: string, personId: string): RosterRow => ({
  full,
  personId,
  source: "waiver-join",
});

describe("normalizeName", () => {
  it("collapses whitespace, case and punctuation", () => {
    // "ROBERT  HENDRICKS" is exactly how the W57387 booking stored it.
    expect(normalizeName("ROBERT  HENDRICKS")).toBe("robert hendricks");
    expect(normalizeName("Robert Hendricks")).toBe("robert hendricks");
    expect(normalizeName("O'Brien, Sean")).toBe("obrien sean");
  });
});

describe("isPlaceholderName", () => {
  it("matches count-based slot labels", () => {
    for (const n of ["Adult 1", "adult 2", "Junior 3", "JUNIOR", "Adult"]) {
      expect(isPlaceholderName(n)).toBe(true);
    }
  });
  it("does not match real people", () => {
    for (const n of ["Adultson Smith", "Junior Alvarez", "Thomas King"]) {
      expect(isPlaceholderName(n)).toBe(false);
    }
  });
});

describe("mergeRosterRows — the W57387 defect", () => {
  it("keeps the BMI person, not the id-less booking label, for one human", () => {
    const out = mergeRosterRows([label("THOMAS KING"), bmi("Thomas King", "57567302")]);
    expect(out).toHaveLength(1);
    expect(out[0].personId).toBe("57567302");
    expect(out[0].source).toBe("bmi-project");
    // BMI's casing survives, so the kiosk stops showing booking-typed ALL CAPS.
    expect(out[0].full).toBe("Thomas King");
  });

  it("is order-independent — the label arriving FIRST must not win", () => {
    const a = mergeRosterRows([label("THOMAS KING"), bmi("Thomas King", "57567302")]);
    const b = mergeRosterRows([bmi("Thomas King", "57567302"), label("THOMAS KING")]);
    expect(a).toEqual(b);
    expect(a[0].personId).toBe("57567302");
  });

  it("matches through a double-spaced booking label", () => {
    const out = mergeRosterRows([label("ROBERT  HENDRICKS"), bmi("Robert Hendricks", "57567287")]);
    expect(out).toHaveLength(1);
    expect(out[0].personId).toBe("57567287");
  });

  it("reproduces the full W57387 roster as ONE card per human", () => {
    // Live data, probed 2026-08-07: 6 people in BMI, 6 id-less booking labels.
    const out = mergeRosterRows([
      label("james rose"),
      label("CALGARO VOLPE"),
      label("ROBERT  HENDRICKS"),
      label("THOMAS KING"),
      label("TIMOTHY HIGGINS"),
      label("TYLER NAGLE"),
      bmi("Tim Higgins", "26581677"),
      bmi("james rose", "63000000005663782"),
      bmi("Robert Hendricks", "57567287"),
      bmi("Thomas King", "57567302"),
      bmi("Tyler Nagle", "58011284"),
      bmi("Calgaro Volpe", "58067533"),
    ]);
    // Before the fix this rendered 7 cards, 4 of them wrongly id-less.
    expect(out).toHaveLength(6);
    expect(out.every((r) => r.personId)).toBe(true);
    expect(new Set(out.map((r) => normalizeName(r.full))).size).toBe(6);
  });
});

describe("mergeRosterRows — source precedence", () => {
  it("prefers BMI over a waiver join for the same person id", () => {
    const out = mergeRosterRows([join("T King", "57567302"), bmi("Thomas King", "57567302")]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("bmi-project");
  });

  it("collapses the short-id / 17-digit-Office-id split for one human", () => {
    const out = mergeRosterRows([
      { full: "Jane Doe", personId: "58011284", source: "waiver-join" },
      { full: "Jane Doe", personId: "63000000005663782", source: "bmi-project" },
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps genuinely different people", () => {
    const out = mergeRosterRows([bmi("Thomas King", "1"), bmi("Tyler Nagle", "2")]);
    expect(out).toHaveLength(2);
  });

  it("keeps an id-less person nobody else covers", () => {
    const out = mergeRosterRows([label("Walk In Guest"), bmi("Thomas King", "1")]);
    expect(out).toHaveLength(2);
  });
});

describe("mergeRosterRows — nickname variants", () => {
  it("drops the id-less TIMOTHY when BMI knows Tim (the screenshot duplicate)", () => {
    const out = mergeRosterRows([label("TIMOTHY HIGGINS"), bmi("Tim Higgins", "26581677")]);
    expect(out).toHaveLength(1);
    expect(out[0].personId).toBe("26581677");
    expect(out[0].full).toBe("Tim Higgins");
  });

  it("handles Sam / Samantha", () => {
    expect(mergeRosterRows([label("Samantha Cole"), bmi("Sam Cole", "9")])).toHaveLength(1);
  });

  it("never merges on a 2-character prefix", () => {
    // Jo Smith and John Smith stay two people.
    expect(mergeRosterRows([label("Jo Smith"), bmi("John Smith", "9")])).toHaveLength(2);
  });

  it("never merges across different surnames", () => {
    expect(mergeRosterRows([label("Tim Nagle"), bmi("Timothy Higgins", "9")])).toHaveLength(2);
  });

  it("refuses to guess when two identified people could claim the label", () => {
    // Tim Higgins AND Timothy Higgins both real — keep all three rather than
    // silently delete a guest.
    const out = mergeRosterRows([
      label("TIMOTH HIGGINS"),
      bmi("Tim Higgins", "1"),
      bmi("Timothy Higgins", "2"),
    ]);
    expect(out).toHaveLength(3);
  });

  it("never drops an IDENTIFIED row as a nickname of another", () => {
    const out = mergeRosterRows([join("Tim Higgins", "1"), bmi("Timothy Higgins", "2")]);
    expect(out).toHaveLength(2);
  });

  it("does not merge a bare first name with no surname", () => {
    const out = mergeRosterRows([label("Tim"), bmi("Timothy Higgins", "9")]);
    expect(out).toHaveLength(2);
  });
});

describe("mergeRosterRows — placeholders and junk", () => {
  it("drops slot labels even when they carry a person id (the whitley incident)", () => {
    const out = mergeRosterRows([bmi("Adult 1", "999"), bmi("Thomas King", "1")]);
    expect(out).toHaveLength(1);
    expect(out[0].full).toBe("Thomas King");
  });

  it("drops rows with neither a name nor an id", () => {
    expect(mergeRosterRows([{ full: "   ", personId: null, source: "booking-label" }])).toEqual([]);
  });

  it("returns an empty array for no input", () => {
    expect(mergeRosterRows([])).toEqual([]);
  });
});

describe("joinWasRemovedFromBmi — staff deleted them in BMI", () => {
  const ids = (...v: string[]) => new Set(v);

  it("treats attached-but-absent as REMOVED (the reported bug)", () => {
    // Test4 attached at 20:37, then staff deleted them; BMI now lists only Eric.
    expect(
      joinWasRemovedFromBmi({
        bmiAnswered: true,
        bmiPersonIds: ids("63000000007642347"),
        attachStatus: "attached",
        personId: "58091668",
      }),
    ).toBe(true);
  });

  it("keeps someone BMI still lists", () => {
    expect(
      joinWasRemovedFromBmi({
        bmiAnswered: true,
        bmiPersonIds: ids("58091668"),
        attachStatus: "attached",
        personId: "58091668",
      }),
    ).toBe(false);
  });

  it("FAILS CLOSED when BMI never answered — absence proves nothing", () => {
    expect(
      joinWasRemovedFromBmi({
        bmiAnswered: false,
        bmiPersonIds: ids(),
        attachStatus: "attached",
        personId: "58091668",
      }),
    ).toBe(false);
  });

  it("never judges a row that never reached BMI", () => {
    for (const st of ["pending", "failed", "skipped", "unresolved"]) {
      expect(
        joinWasRemovedFromBmi({
          bmiAnswered: true,
          bmiPersonIds: ids(),
          attachStatus: st,
          personId: "58091668",
        }),
      ).toBe(false);
    }
  });

  it("never judges a row with no person id", () => {
    expect(
      joinWasRemovedFromBmi({
        bmiAnswered: true,
        bmiPersonIds: ids(),
        attachStatus: "attached",
        personId: null,
      }),
    ).toBe(false);
  });
});
