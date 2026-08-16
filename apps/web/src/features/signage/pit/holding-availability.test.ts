import { describe, expect, it } from "vitest";
import { holdingAvailability } from "./holding-availability";

/**
 * The cases that matter are the two that look alike: holding is occupied by
 * somebody else, and the answer is opposite depending on whether that somebody
 * has actually gone out. Everything else is bookkeeping.
 */
describe("holdingAvailability", () => {
  it("allows an empty holding slot", () => {
    expect(
      holdingAvailability({ holding: null, racing: null, pitIn: null, sessionId: "101" }),
    ).toEqual({ ok: true });
  });

  it("allows a re-send of the group already in the seats", () => {
    expect(
      holdingAvailability({
        holding: { sessionId: "101", heatNumber: 27 },
        racing: null,
        pitIn: null,
        sessionId: "101",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses when the occupant is still genuinely in the seats", () => {
    const verdict = holdingAvailability({
      holding: { sessionId: "101", heatNumber: 27 },
      racing: null,
      pitIn: null,
      sessionId: "102",
    });
    expect(verdict.ok).toBe(false);
    // The staff-facing sentence is part of the contract — it is what the disabled
    // button says, and what the API returns on a race between two desks.
    if (!verdict.ok) {
      expect(verdict.error).toContain("Session 27 is still in holding");
      expect(verdict.error).toContain("Move them to the karts first");
    }
  });

  it("allows the normal back-to-back send — the stored occupant is already racing", () => {
    expect(
      holdingAvailability({
        holding: { sessionId: "101", heatNumber: 27 },
        racing: { sessionId: "101" },
        pitIn: null,
        sessionId: "102",
      }),
    ).toEqual({ ok: true });
  });

  it("allows it when the occupant has come back in and is sitting in pit-in", () => {
    expect(
      holdingAvailability({
        holding: { sessionId: "101", heatNumber: 27 },
        racing: null,
        pitIn: { sessionId: "101" },
        sessionId: "102",
      }),
    ).toEqual({ ok: true });
  });

  it("names the group generically when the heat number is unknown", () => {
    const verdict = holdingAvailability({
      holding: { sessionId: "101", heatNumber: null },
      racing: null,
      pitIn: null,
      sessionId: "102",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("another group is still in holding");
  });

  it("compares ids as strings — a 17-digit id must not be coerced", () => {
    // Two DIFFERENT ids that collide once they pass through Number().
    const a = "90071992547409931";
    const b = "90071992547409932";
    expect(Number(a)).toBe(Number(b)); // the trap this guards against
    const verdict = holdingAvailability({
      holding: { sessionId: a, heatNumber: 27 },
      racing: { sessionId: b },
      pitIn: null,
      sessionId: "102",
    });
    // b is NOT a, so the occupant has not gone out and the send must be refused.
    expect(verdict.ok).toBe(false);
  });
});
