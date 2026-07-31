import { describe, expect, it } from "vitest";
import { newPartyMember } from "~/features/booking";
import { prefillPartyMembers } from "./party-prefill";
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
