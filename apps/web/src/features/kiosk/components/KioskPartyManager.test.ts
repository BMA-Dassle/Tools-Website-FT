import { describe, expect, it } from "vitest";
import { newPartyMember, type PartyMember } from "~/features/booking/state/types";
import { needsSetup, peopleReady, shortPandoraId } from "./KioskPartyManager";

/** Build a PartyMember, spreading overrides that newPartyMember doesn't accept
 *  (e.g. pandoraPersonId). */
const member = (over: Partial<PartyMember> = {}): PartyMember => ({
  ...newPartyMember({ firstName: over.firstName ?? "Alex" }),
  ...over,
});

describe("needsSetup", () => {
  it("needs setup without an account", () => {
    expect(needsSetup(member({ bmiPersonId: undefined, waiverValid: undefined }))).toBe(true);
  });
  it("needs setup with an account but no valid waiver", () => {
    expect(needsSetup(member({ bmiPersonId: "123", waiverValid: false }))).toBe(true);
  });
  it("is ready with an account + valid waiver", () => {
    expect(needsSetup(member({ bmiPersonId: "123", waiverValid: true }))).toBe(false);
  });
});

describe("peopleReady", () => {
  it("blocks an empty party", () => {
    expect(peopleReady([], [])).not.toBe(true);
  });

  it("blocks when an included member still needs setup", () => {
    const a = member({ firstName: "Ann", bmiPersonId: "1", waiverValid: true });
    const b = member({ firstName: "Bob" }); // no account
    const res = peopleReady([a, b], [a.id, b.id]);
    expect(res).not.toBe(true);
    if (res !== true) expect(res.reason).toContain("Bob");
  });

  it("blocks a minor with no guardian", () => {
    const kid = member({ firstName: "Kit", bmiPersonId: "1", waiverValid: true, isMinor: true });
    const res = peopleReady([kid], [kid.id]);
    expect(res).not.toBe(true);
    if (res !== true) expect(res.reason).toContain("Kit");
  });

  it("passes when everyone is ready and every minor has a guardian", () => {
    const mom = member({ firstName: "Mom", bmiPersonId: "1", waiverValid: true });
    const kid = member({
      firstName: "Kid",
      bmiPersonId: "2",
      waiverValid: true,
      isMinor: true,
      guardianMemberId: mom.id,
    });
    expect(peopleReady([mom, kid], [mom.id, kid.id])).toBe(true);
  });

  it("only gates the included subset (attraction toggle)", () => {
    const inA = member({ firstName: "In", bmiPersonId: "1", waiverValid: true });
    const outB = member({ firstName: "Out" }); // not ready, but not included
    expect(peopleReady([inA, outB], [inA.id])).toBe(true);
  });
});

describe("shortPandoraId (the id Pandora's waiver-sign accepts)", () => {
  it("prefers the short pandoraPersonId over a 17-digit Office id", () => {
    expect(
      shortPandoraId(member({ pandoraPersonId: "555", bmiPersonId: "12345678901234567" })),
    ).toBe("555");
  });
  it("uses a short bmiPersonId (a freshly created person)", () => {
    expect(shortPandoraId(member({ bmiPersonId: "5551234" }))).toBe("5551234");
  });
  it("returns null for a 17-digit Office id (must upsert-resolve the short id first)", () => {
    expect(shortPandoraId(member({ bmiPersonId: "12345678901234567" }))).toBeNull();
  });
  it("returns null when no id is known", () => {
    expect(
      shortPandoraId(member({ bmiPersonId: undefined, pandoraPersonId: undefined })),
    ).toBeNull();
  });
});
