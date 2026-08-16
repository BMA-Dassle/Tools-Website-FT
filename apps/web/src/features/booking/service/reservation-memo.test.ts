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

  it("keeps all five v1 parts in one string (v1 de-clobber guard)", () => {
    // v1 /book/race used to fire FOUR independent booking/memo writes — package
    // (race page, at heat-book time), then Express Lane, POV and group (all on
    // the confirmation page). booking/memo overwrites, so the last one won and
    // the Ultimate Qualifier's handling rules were destroyed on any booking that
    // also claimed a POV code. v1's confirmation page now composes this exact
    // part-set into ONE write; if a part stops surviving, that bug is back.
    const memo = buildReservationMemo({
      expressLaneResNumber: "W38749",
      ultimateQualifierNote: "** ULTIMATE QUALIFIER ** verify level-up.",
      isThreeRacePack: true,
      povCodes: ["AB12"],
      relatedReservations: "W100 (Sam)",
    });
    expect(memo).toContain("EXPRESS LANE");
    expect(memo).toContain("ULTIMATE QUALIFIER");
    expect(memo).toContain(THREE_RACE_PACK_MEMO);
    expect(memo).toContain("POV Codes: AB12");
    expect(memo).toContain("related reservations: W100 (Sam)");
    // v1 has no short-link mint and never wrote an amount — those stay absent
    // rather than silently appearing as empty lines.
    expect(memo).not.toContain("Booking: ");
    expect(memo).not.toContain("Paid online");
    expect(memo.split("\n")).toHaveLength(5);
  });

  it("puts the tier-expectation warning right after the package disclaimer", () => {
    // Both are for the person at the counter handling an unhappy guest, so they
    // read as one block. If the warning drifted below the POV codes, the two
    // halves of the same conversation would be separated by unrelated noise.
    const memo = buildReservationMemo({
      expressLaneResNumber: "W1",
      ultimateQualifierNote: "** ULTIMATE QUALIFIER ** verify level-up.",
      raceWarningNote: "** JUNIOR STARTER — UPGRADE DECLINED ** was warned.",
      povCodes: ["AB12"],
    });
    const lines = memo.split("\n");
    expect(lines[1]).toContain("ULTIMATE QUALIFIER");
    expect(lines[2]).toContain("JUNIOR STARTER — UPGRADE DECLINED");
    expect(lines[3]).toContain("POV Codes");
  });

  it("omits the warning line when nothing was acknowledged", () => {
    // raceWarningMemo returns null for "no ack", and a null part must not
    // produce an empty line that reads as a missing memo.
    const memo = buildReservationMemo({ expressLaneResNumber: "W1", raceWarningNote: null });
    expect(memo.split("\n")).toHaveLength(1);
    expect(memo).toContain("EXPRESS LANE");
  });

  it("omits parts that don't apply", () => {
    expect(buildReservationMemo({ povCodes: ["X1"] })).toBe(
      "POV Codes: X1 — emailed & texted to guest.",
    );
    expect(buildReservationMemo({ povCodes: [], amountPaid: 0 })).toBe("");
    expect(buildReservationMemo({})).toBe("");
  });
});
