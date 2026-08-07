import { describe, expect, it } from "vitest";
import { newPartyMember } from "~/features/booking";
import { isPlaceholderRacerName, prefillPartyMembers } from "./party-prefill";
import type { CheckinPartyMember } from "./types";

const roster: CheckinPartyMember[] = [
  { firstName: "Eric", lastName: "Osborn", bmiPersonId: "63000000001234567", waiverValid: true },
  { firstName: "Alex", lastName: "Smith", bmiPersonId: "63000000007654321", waiverValid: false },
  { firstName: "Sam", waiverValid: false }, // bowling-only guest, no id
];

describe("prefillPartyMembers", () => {
  it("converts every roster member on an empty party, carrying id + live waiver status", () => {
    const out = prefillPartyMembers([], roster);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      firstName: "Eric",
      lastName: "Osborn",
      bmiPersonId: "63000000001234567",
      waiverValid: true,
      isNewRacer: false,
    });
    expect(out[1].waiverValid).toBe(false); // lapsed → still walks the waiver step
    expect(out[2].bmiPersonId).toBeUndefined();
  });

  it("skips people already on the party by id — a double tap never duplicates", () => {
    const existing = [
      newPartyMember({
        firstName: "Eric",
        isNewRacer: false,
        bmiPersonId: "63000000001234567",
      }),
    ];
    const out = prefillPartyMembers(existing, roster);
    expect(out.map((m) => m.firstName)).toEqual(["Alex", "Sam"]);
  });

  it("skips id-less roster rows already present by name", () => {
    const existing = [newPartyMember({ firstName: "Sam", isNewRacer: false })];
    const out = prefillPartyMembers(existing, roster);
    expect(out.map((m) => m.firstName)).toEqual(["Eric", "Alex"]);
  });

  it("dedupes within the roster batch itself, KEEPING the identified row", () => {
    const out = prefillPartyMembers(
      [],
      [...roster, { firstName: "eric", lastName: "OSBORN", waiverValid: true }],
    );
    const erics = out.filter((m) => m.firstName.toLowerCase() === "eric");
    expect(erics).toHaveLength(1);
    // The old assertion stopped at the count, so it would have passed even if
    // the id-less clone won and the person id was silently dropped — which is
    // exactly the W57387 failure.
    expect(erics[0].bmiPersonId).toBe("63000000001234567");
    expect(erics[0].waiverValid).toBe(true);
  });

  it("keeps the identified row even when the id-less clone comes FIRST", () => {
    const out = prefillPartyMembers(
      [],
      [
        { firstName: "eric", lastName: "OSBORN", waiverValid: false },
        {
          firstName: "Eric",
          lastName: "Osborn",
          bmiPersonId: "63000000001234567",
          waiverValid: true,
        },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0].bmiPersonId).toBe("63000000001234567");
    expect(out[0].waiverValid).toBe(true);
  });

  it("matches a party member through a double-spaced booking label", () => {
    const existing = [
      newPartyMember({ firstName: "Robert", lastName: "Hendricks", isNewRacer: false }),
    ];
    const out = prefillPartyMembers(existing, [
      { firstName: "ROBERT", lastName: " HENDRICKS", waiverValid: false },
    ]);
    expect(out).toEqual([]);
  });

  it("does not offer TIMOTHY when the party already has Tim (the W57387 duplicate)", () => {
    const existing = [
      newPartyMember({
        firstName: "Tim",
        lastName: "Higgins",
        isNewRacer: false,
        bmiPersonId: "26581677",
      }),
    ];
    const out = prefillPartyMembers(existing, [
      { firstName: "TIMOTHY", lastName: "HIGGINS", waiverValid: false },
    ]);
    expect(out).toEqual([]);
  });

  it("still offers a different surname that happens to share a forename prefix", () => {
    const existing = [newPartyMember({ firstName: "Tim", lastName: "Higgins", isNewRacer: false })];
    const out = prefillPartyMembers(existing, [
      { firstName: "Timothy", lastName: "Nagle", waiverValid: false },
    ]);
    expect(out.map((m) => m.firstName)).toEqual(["Timothy"]);
  });
});

describe("isPlaceholderRacerName", () => {
  it("matches the count-based booking slot labels, case-insensitively", () => {
    // Exactly what RacePartyStep's setNewRacerCount mints: `Adult ${i + 1}`.
    expect(isPlaceholderRacerName("Adult 1")).toBe(true);
    expect(isPlaceholderRacerName("Adult 12")).toBe(true);
    expect(isPlaceholderRacerName("Junior 3")).toBe(true);
    expect(isPlaceholderRacerName("  adult 2  ")).toBe(true);
    expect(isPlaceholderRacerName("JUNIOR 1")).toBe(true);
  });

  it("never flags a real name", () => {
    // 2026-07-31 whitley check-in: "Adult 1"/"Adult 2" slot labels became BMI
    // people-list names. The filter must catch labels — and ONLY labels.
    expect(isPlaceholderRacerName("Tori Whitley")).toBe(false);
    expect(isPlaceholderRacerName("Adult")).toBe(false); // no ordinal → mononym
    expect(isPlaceholderRacerName("Junior")).toBe(false); // legit given name
    expect(isPlaceholderRacerName("Junior Soprano")).toBe(false);
    expect(isPlaceholderRacerName("Adaline 1")).toBe(false);
    expect(isPlaceholderRacerName("")).toBe(false);
  });
});
