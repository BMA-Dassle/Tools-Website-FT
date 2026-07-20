import { describe, expect, it } from "vitest";
import { newPartyMember } from "~/features/booking";
import { guestToPartyMember, mergeJoinedGuests } from "./merge";
import type { JoinGuestPayload } from "./types";

function guest(overrides: Partial<JoinGuestPayload> = {}): JoinGuestPayload {
  return {
    firstName: "Sam",
    lastName: "Rider",
    bmiPersonId: "88421",
    pandoraPersonId: "88421",
    isNewRacer: true,
    category: "adult",
    waiverValid: true,
    dobIso: "1992-04-10",
    phone: "2395551234",
    email: "sam@example.com",
    ...overrides,
  };
}

describe("guestToPartyMember", () => {
  it("maps a phone join onto a ready roster member", () => {
    const m = guestToPartyMember(guest());
    expect(m.firstName).toBe("Sam");
    expect(m.bmiPersonId).toBe("88421");
    expect(m.pandoraPersonId).toBe("88421");
    expect(m.waiverValid).toBe(true); // arrives signed → card renders green
    expect(m.category).toBe("adult");
    expect(m.isMinor).toBe(false);
    expect(m.isNewRacer).toBe(true);
    expect(m.isBillingCustomer).toBeUndefined(); // main stays kiosk-side
    expect(m.dobIso).toBe("1992-04-10");
  });

  it("keeps a returning guest's tier + credits and 17-digit id as a string", () => {
    const m = guestToPartyMember(
      guest({
        bmiPersonId: "12345678901234567",
        pandoraPersonId: "77001",
        isNewRacer: false,
        memberships: ["PRO 2026"],
        creditBalances: [{ kind: "race", balance: 3 }],
      }),
    );
    expect(m.bmiPersonId).toBe("12345678901234567");
    expect(m.pandoraPersonId).toBe("77001");
    expect(m.isNewRacer).toBe(false);
    expect(m.memberships).toEqual(["PRO 2026"]);
    expect(m.creditBalances).toEqual([{ kind: "race", balance: 3 }]);
  });

  it("derives category/isMinor from the DOB defensively", () => {
    const year = new Date().getFullYear();
    const m = guestToPartyMember(guest({ dobIso: `${year - 15}-01-10` }));
    expect(m.isMinor).toBe(true); // server enforces 18+; kiosk never trusts it
    const junior = guestToPartyMember(guest({ dobIso: `${year - 10}-01-10` }));
    expect(junior.category).toBe("junior");
  });
});

describe("mergeJoinedGuests", () => {
  it("adds unknown guests to the roster", () => {
    const { toAdd, promoteGuardians, alreadyPresent } = mergeJoinedGuests([], [], [guest()]);
    expect(toAdd).toHaveLength(1);
    expect(promoteGuardians).toHaveLength(0);
    expect(alreadyPresent).toHaveLength(0);
  });

  it("skips a guest already in the party (id match) and reports them", () => {
    const existing = newPartyMember({ firstName: "Sam", bmiPersonId: "88421" });
    const result = mergeJoinedGuests([existing], [], [guest()]);
    expect(result.toAdd).toHaveLength(0);
    // Carries the phone-resolved short id so the step can enrich the member.
    expect(result.alreadyPresent).toEqual([{ memberId: existing.id, pandoraPersonId: "88421" }]);
  });

  it("matches across id FIELDS — phone short id vs kiosk member pandoraPersonId", () => {
    // Kiosk lookup member: 17-digit Office id + resolved short Pandora id.
    const existing = {
      ...newPartyMember({ firstName: "Sam", bmiPersonId: "12345678901234567" }),
      pandoraPersonId: "88421",
    };
    // Phone join carries the SHORT id in both fields (submitNew mirror).
    const result = mergeJoinedGuests([existing], [], [guest()]);
    expect(result.toAdd).toHaveLength(0);
    expect(result.alreadyPresent.map((h) => h.memberId)).toEqual([existing.id]);
  });

  it("falls back to name+DOB when a member carries no ids", () => {
    const existing = newPartyMember({ firstName: "sam", lastName: "RIDER", dobIso: "1992-04-10" });
    const result = mergeJoinedGuests([existing], [], [guest()]);
    expect(result.toAdd).toHaveLength(0);
    expect(result.alreadyPresent.map((h) => h.memberId)).toEqual([existing.id]);
  });

  it("dedupes within one batch (double submit)", () => {
    const result = mergeJoinedGuests([], [], [guest(), guest()]);
    expect(result.toAdd).toHaveLength(1);
  });

  it("promotes a signer-only guardian instead of duplicating them", () => {
    const guardian = { ...newPartyMember({ firstName: "Sam" }), pandoraPersonId: "88421" };
    const result = mergeJoinedGuests([], [guardian], [guest()]);
    expect(result.toAdd).toHaveLength(0);
    expect(result.promoteGuardians).toEqual([guardian]); // SAME object id — wards' refs stay valid
  });

  it("handles a mixed batch — new, duplicate, and guardian", () => {
    const existing = newPartyMember({ firstName: "Ann", bmiPersonId: "111" });
    const guardian = { ...newPartyMember({ firstName: "Gus" }), pandoraPersonId: "222" };
    const result = mergeJoinedGuests(
      [existing],
      [guardian],
      [
        guest(), // new
        guest({ firstName: "Ann", bmiPersonId: "111", pandoraPersonId: undefined }), // dup
        guest({ firstName: "Gus", bmiPersonId: "222", pandoraPersonId: "222" }), // guardian
      ],
    );
    expect(result.toAdd.map((m) => m.firstName)).toEqual(["Sam"]);
    expect(result.alreadyPresent.map((h) => h.memberId)).toEqual([existing.id]);
    expect(result.promoteGuardians).toEqual([guardian]);
  });
});
