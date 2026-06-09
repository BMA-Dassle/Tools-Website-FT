import { describe, it, expect } from "vitest";
import { buildReservationMemo, THREE_RACE_PACK_MEMO } from "./reservation-memo";

describe("buildReservationMemo", () => {
  it("includes EVERY applicable note in priority order (the override-bug guard)", () => {
    const memo = buildReservationMemo({
      expressLaneResNumber: "W38749",
      bookingUrl: "https://x/book/confirmation/v2?billId=1",
      ultimateQualifierNote: "** ULTIMATE QUALIFIER ** verify level-up.",
      isThreeRacePack: true,
      povCodes: ["AB12", "CD34"],
      relatedReservations: "W100 (Sam)",
      amountPaid: 50.02,
    });
    const lines = memo.split("\n");
    // All seven parts present...
    expect(lines).toHaveLength(7);
    // ...in the agreed priority order.
    expect(lines[0]).toContain("EXPRESS LANE");
    expect(lines[1]).toContain("Booking: https://x/");
    expect(lines[2]).toContain("ULTIMATE QUALIFIER");
    expect(lines[3]).toBe(THREE_RACE_PACK_MEMO);
    expect(lines[4]).toContain("POV Codes: AB12, CD34");
    expect(lines[5]).toContain("related reservations: W100 (Sam)");
    expect(lines[6]).toBe("Paid online: $50.02");
  });

  it("3-race pack does NOT drop express lane (the exact v1 regression)", () => {
    const memo = buildReservationMemo({ expressLaneResNumber: "W1", isThreeRacePack: true });
    expect(memo).toContain("EXPRESS LANE");
    expect(memo).toContain(THREE_RACE_PACK_MEMO);
  });

  it("omits parts that don't apply", () => {
    expect(buildReservationMemo({ povCodes: ["X1"] })).toBe(
      "POV Codes: X1 — emailed & texted to guest.",
    );
    expect(buildReservationMemo({ povCodes: [], amountPaid: 0 })).toBe("");
    expect(buildReservationMemo({})).toBe("");
  });
});
