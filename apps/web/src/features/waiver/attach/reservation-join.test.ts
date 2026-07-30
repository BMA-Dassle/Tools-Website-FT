/**
 * Who lands in a real event's headcount. A wrong answer here is not cosmetic:
 * the reservation's person count feeds guest totals and billing, so a parent who
 * only signed for their kid must not be counted as attending.
 */
import { describe, it, expect } from "vitest";
import type { PartyMember } from "~/features/booking";
import { attachPersonId } from "./reservation-join";

const member = (over: Partial<PartyMember>): PartyMember =>
  ({
    id: "m1",
    firstName: "Ann",
    waiverValid: true,
    pandoraPersonId: "p1",
    ...over,
  }) as PartyMember;

describe("attachPersonId", () => {
  it("attaches a participating member with a valid waiver", () => {
    const m = member({ id: "m1" });
    expect(attachPersonId(m, new Set(["m1"]))).toBe("p1");
  });

  it("does NOT attach a signer-only guardian", () => {
    // The guardian is in the party (their own waiver is tracked, and the minor
    // references them) but is absent from the participating set.
    const guardian = member({ id: "g1", firstName: "Dad" });
    expect(attachPersonId(guardian, new Set(["kid"]))).toBeNull();
  });

  it("attaches everyone when no participating set is given (kiosk behavior)", () => {
    const guardian = member({ id: "g1" });
    expect(attachPersonId(guardian, null)).toBe("p1");
  });

  it("never attaches before the waiver is valid", () => {
    const m = member({ id: "m1", waiverValid: false });
    expect(attachPersonId(m, new Set(["m1"]))).toBeNull();
  });

  it("prefers the short Pandora id but falls back to the Office id", () => {
    const short = member({ pandoraPersonId: "short", bmiPersonId: "12345678901234567" });
    expect(attachPersonId(short, null)).toBe("short");
    const officeOnly = member({ pandoraPersonId: undefined, bmiPersonId: "12345678901234567" });
    // String, never Number() — a 17-digit BMI id loses precision as a number.
    expect(attachPersonId(officeOnly, null)).toBe("12345678901234567");
  });

  it("skips a member with no person id at all", () => {
    const m = member({ pandoraPersonId: undefined, bmiPersonId: undefined });
    expect(attachPersonId(m, null)).toBeNull();
  });
});
