import { describe, expect, it } from "vitest";
import { newPartyMember } from "~/features/booking";
import { prefillPartyMembers } from "../checkin/party-prefill";
import type { CheckinPartyMember } from "../checkin/types";
import { mergeRosters, personChipState, type VoucherPartyPerson } from "./voucher-party";

const ERIC: CheckinPartyMember = {
  firstName: "Eric",
  lastName: "Osborn",
  bmiPersonId: "63000000001234567",
  waiverValid: true,
};
const ALEX: CheckinPartyMember = {
  firstName: "Alex",
  lastName: "Smith",
  bmiPersonId: "63000000007654321",
  waiverValid: false,
};
const SAM: CheckinPartyMember = { firstName: "Sam", waiverValid: false }; // bowling-only, no id

describe("mergeRosters", () => {
  it("collapses two vouchers from the same booking to one chip per person", () => {
    const out = mergeRosters({
      "HPW-AAAA-AAAA": [ERIC, ALEX, SAM],
      "HPW-BBBB-BBBB": [ERIC, ALEX, SAM],
    });
    expect(out.map((p) => p.firstName)).toEqual(["Eric", "Alex", "Sam"]);
    // 17-digit ids stay STRINGS end to end.
    expect(out[0].bmiPersonId).toBe("63000000001234567");
  });

  it("dedupes id-less rows by name key (case/whitespace-insensitive); an id-bearing duplicate upgrades without re-keying", () => {
    const out = mergeRosters({
      A: [{ firstName: "  sam ", waiverValid: false }],
      B: [{ firstName: "Sam", bmiPersonId: "63000000009999999", waiverValid: true }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].bmiPersonId).toBe("63000000009999999"); // upgraded
    expect(out[0].key).toBe("name:sam|"); // key stable — addedIds tracking survives
    expect(out[0].waiverValid).toBe(true); // ORed
  });

  it("ORs waiverValid across duplicates, keeps first-seen order, and drops placeholder slot labels", () => {
    const out = mergeRosters({
      A: [{ ...ALEX, waiverValid: false }, SAM],
      B: [
        { ...ALEX, waiverValid: true },
        { firstName: "Adult", lastName: "1", waiverValid: false }, // slot label, not a person
        ERIC,
      ],
    });
    expect(out.map((p) => p.firstName)).toEqual(["Alex", "Sam", "Eric"]);
    expect(out[0].waiverValid).toBe(true);
  });

  it("different bookings union", () => {
    const out = mergeRosters({ A: [ERIC], B: [SAM] });
    expect(out.map((p) => p.firstName)).toEqual(["Eric", "Sam"]);
  });
});

describe("personChipState", () => {
  const [ericChip, alexChip, samChip] = mergeRosters({ A: [ERIC, ALEX, SAM] });

  it("id match → in-group when this selector didn't add them, added when it did", () => {
    const member = newPartyMember({
      firstName: "Eric",
      isNewRacer: false,
      bmiPersonId: "63000000001234567",
    });
    expect(personChipState(ericChip, [member], {})).toEqual({
      state: "in-group",
      memberId: member.id,
    });
    expect(personChipState(ericChip, [member], { [ericChip.key]: member.id })).toEqual({
      state: "added",
      memberId: member.id,
    });
  });

  it("name-key fallback matches an id-less member; no match at all → idle", () => {
    const samMember = newPartyMember({ firstName: "Sam", isNewRacer: false });
    expect(personChipState(samChip, [samMember], {}).state).toBe("in-group");
    expect(personChipState(alexChip, [samMember], {}).state).toBe("idle");
    expect(personChipState(alexChip, [], {}).state).toBe("idle");
  });

  it("round-trip lock with prefillPartyMembers: idle ⇒ prefill adds exactly one; selected ⇒ adds zero", () => {
    const party = [
      newPartyMember({ firstName: "Eric", isNewRacer: false, bmiPersonId: "63000000001234567" }),
      newPartyMember({ firstName: "Sam", isNewRacer: false }),
    ];
    const chips: VoucherPartyPerson[] = [ericChip, alexChip, samChip];
    for (const chip of chips) {
      const { state } = personChipState(chip, party, {});
      const added = prefillPartyMembers(party, [chip]);
      expect(added).toHaveLength(state === "idle" ? 1 : 0);
    }
  });
});
