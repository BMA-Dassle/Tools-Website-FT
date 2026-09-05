import { describe, expect, it } from "vitest";
import {
  allSelected,
  resolvePicks,
  selectableLinked,
  splitWarnNeeded,
  tooYoungToRace,
  type LinkedPerson,
} from "./family-picker";

const person = (id: string, age: number | null, waiverValid = true): LinkedPerson => ({
  id,
  age,
  waiverValid,
});

// A real household: two adults, a teen, two kids — one of them under the kart
// floor — and a relative whose linked record carries no birthday at all.
const FAMILY: LinkedPerson[] = [
  person("maria", 42),
  person("diego", 15),
  person("sofia", 12, false),
  person("mateo", 9),
  person("lucia", 6, false),
  person("rosa", null),
];

describe("tooYoungToRace", () => {
  it("blocks an under-7 on a RACE screen", () => {
    expect(tooYoungToRace(6, true)).toBe(true);
  });
  it("lets the same child onto an ATTRACTION screen", () => {
    expect(tooYoungToRace(6, false)).toBe(false);
  });
  it("does not block an unknown age — the waiver step resolves the real DOB", () => {
    expect(tooYoungToRace(null, true)).toBe(false);
  });
  it("7 exactly is old enough (the floor is 7+, not over-7)", () => {
    expect(tooYoungToRace(7, true)).toBe(false);
  });
});

describe("selectableLinked", () => {
  it("drops only the under-7 when racing", () => {
    expect(selectableLinked(FAMILY, true).map((l) => l.id)).toEqual([
      "maria",
      "diego",
      "sofia",
      "mateo",
      "rosa",
    ]);
  });
  it("keeps the whole family for an attraction", () => {
    expect(selectableLinked(FAMILY, false)).toHaveLength(FAMILY.length);
  });
});

describe("resolvePicks", () => {
  it("returns just the selected relatives", () => {
    const picks = resolvePicks(FAMILY, new Set(["maria", "sofia"]), true);
    expect(picks.map((p) => p.id)).toEqual(["maria", "sofia"]);
  });

  it("never lets an under-7 ride a race batch in, even if selected", () => {
    // Select-all on an ATTRACTION then switching to a race would otherwise
    // carry Lucía across — the sheet disables her card, this is the guard.
    const picks = resolvePicks(FAMILY, new Set(["mateo", "lucia"]), true);
    expect(picks.map((p) => p.id)).toEqual(["mateo"]);
  });

  it("ignores a selected id that is no longer on the list", () => {
    expect(resolvePicks(FAMILY, new Set(["ghost"]), false)).toEqual([]);
  });

  it("adding someone who still needs a waiver is allowed — they sign next", () => {
    const picks = resolvePicks(FAMILY, new Set(["sofia"]), true);
    expect(picks).toHaveLength(1);
    expect(picks[0].waiverValid).toBe(false);
  });
});

describe("allSelected", () => {
  it("is true only when every selectable person is picked", () => {
    expect(allSelected(5, 5)).toBe(true);
    expect(allSelected(4, 5)).toBe(false);
  });
  it("an empty list never reads as fully selected", () => {
    expect(allSelected(0, 0)).toBe(false);
  });
});

describe("splitWarnNeeded", () => {
  const base = { wholeParty: false, alreadyWarned: false };

  it("warns on the tap that grows an attraction party past 3", () => {
    expect(splitWarnNeeded({ ...base, partyLength: 3, adding: 1 })).toBe(true);
  });

  it("does not warn while the party is still small", () => {
    expect(splitWarnNeeded({ ...base, partyLength: 2, adding: 1 })).toBe(false);
  });

  it("a BATCH that lands on 4 warns just like a run of single taps", () => {
    // The regression the family picker could have introduced: adding 3 people
    // at once to a party of 1 used to slip past `party.length >= 3`.
    expect(splitWarnNeeded({ ...base, partyLength: 1, adding: 3 })).toBe(true);
  });

  it("a batch that stays at 3 does not warn", () => {
    expect(splitWarnNeeded({ ...base, partyLength: 1, adding: 2 })).toBe(false);
  });

  it("racing is exempt — the whole party rides one booking", () => {
    expect(splitWarnNeeded({ ...base, wholeParty: true, partyLength: 5, adding: 4 })).toBe(false);
  });

  it("only ever warns once per visit", () => {
    expect(splitWarnNeeded({ ...base, alreadyWarned: true, partyLength: 8, adding: 4 })).toBe(
      false,
    );
  });
});
