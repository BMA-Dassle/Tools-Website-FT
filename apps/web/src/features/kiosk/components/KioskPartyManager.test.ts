import { describe, expect, it } from "vitest";
import { newPartyMember, type PartyMember } from "~/features/booking/state/types";
import { needsSetup, peopleReady, shortPandoraId, waiverCompletePatch } from "./KioskPartyManager";

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

  it("blocks a minor whose guardianMemberId is the EMPTY STRING (sign-time pre-sign state)", () => {
    // Under sign-time resolution submitNew stores guardianId="" on the minor —
    // this is the state waiverCompletePatch exists to repair at sign-complete.
    const kid = member({
      firstName: "Kit",
      bmiPersonId: "1",
      waiverValid: true,
      isMinor: true,
      guardianMemberId: "",
    });
    expect(peopleReady([kid], [kid.id])).not.toBe(true);
  });
});

describe("waiverCompletePatch (sign-time guardian lands on the minor)", () => {
  it("records the resolved guardian when the completed waiver is the chain's minor", () => {
    expect(waiverCompletePatch("kid-1", { minorMemberId: "kid-1", guardianId: "g-1" })).toEqual({
      waiverValid: true,
      guardianMemberId: "g-1",
    });
  });

  it("does not touch guardianMemberId for the guardian's OWN waiver in the same chain", () => {
    expect(waiverCompletePatch("g-1", { minorMemberId: "kid-1", guardianId: "g-1" })).toEqual({
      waiverValid: true,
    });
  });

  it("does not touch guardianMemberId outside a chain, or when the signer never resolved", () => {
    expect(waiverCompletePatch("kid-1", null)).toEqual({ waiverValid: true });
    expect(waiverCompletePatch("kid-1", { minorMemberId: "kid-1" })).toEqual({
      waiverValid: true,
    });
  });

  it("the patched minor passes peopleReady — the /waiver flow can finish (2026-07-30)", () => {
    // The exact live regression: kid signed via the sign-time chain, guardian is a
    // signer-only adult (NOT in the party), guardianMemberId still "".
    const kid = member({
      firstName: "Kid",
      bmiPersonId: "2",
      waiverValid: false,
      isMinor: true,
      guardianMemberId: "",
    });
    const patched = {
      ...kid,
      ...waiverCompletePatch(kid.id, { minorMemberId: kid.id, guardianId: "signer-only-adult" }),
    };
    expect(peopleReady([patched], [patched.id])).toBe(true);
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
