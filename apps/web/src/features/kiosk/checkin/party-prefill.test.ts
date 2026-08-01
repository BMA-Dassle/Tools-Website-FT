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

  it("dedupes within the roster batch itself", () => {
    const out = prefillPartyMembers(
      [],
      [...roster, { firstName: "eric", lastName: "OSBORN", waiverValid: true }],
    );
    expect(out.filter((m) => m.firstName.toLowerCase() === "eric")).toHaveLength(1);
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
