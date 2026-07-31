import { describe, expect, it } from "vitest";
import { parseIntercardSwipe, parseSquareGiftSwipe, parseWedgeBurst } from "./wedge";

describe("parseWedgeBurst", () => {
  it("parses a full two-track burst", () => {
    const c = parseWedgeBurst(
      "%B6039123456789012^GAME/CARD^49121200000?;6039123456789012=49121200000?",
    );
    expect(c.tracks.track1).toBe("B6039123456789012^GAME/CARD^49121200000");
    expect(c.tracks.track2).toBe("6039123456789012=49121200000");
    expect(c.cardNumber).toBe("6039123456789012");
  });

  it("parses a track-2-only swipe (common wedge config)", () => {
    const c = parseWedgeBurst(";6039001122334455=0000?\r");
    expect(c.tracks.track1).toBeNull();
    expect(c.tracks.track2).toBe("6039001122334455=0000");
    expect(c.cardNumber).toBe("6039001122334455");
  });

  it("handles a second ; track as track 3", () => {
    const c = parseWedgeBurst(";1111222233334444=1?;99887766?");
    expect(c.tracks.track2).toBe("1111222233334444=1");
    expect(c.tracks.track3).toBe("99887766");
    expect(c.cardNumber).toBe("1111222233334444");
  });

  it("tolerates stripped sentinels and bare-digit reads", () => {
    expect(parseWedgeBurst("6039445566778899\n").cardNumber).toBe("6039445566778899");
    expect(parseWedgeBurst("card 12345678 ok").cardNumber).toBe("12345678");
  });

  it("takes the PAN from track 1 when track 2 is absent", () => {
    const c = parseWedgeBurst("%B6039445566778899^X?");
    expect(c.cardNumber).toBe("6039445566778899");
  });

  it("returns null when nothing usable is present", () => {
    const c = parseWedgeBurst("%?;?");
    expect(c.tracks.track1).toBeNull();
    expect(c.tracks.track2).toBeNull();
    expect(c.cardNumber).toBeNull();
  });
});

describe("parseIntercardSwipe", () => {
  it("parses the canonical serial swipe burst, keeping leading zeros", () => {
    expect(parseIntercardSwipe(";6283=0000000001037356?\r\n")).toBe("0000000001037356");
  });

  it("finds the 6283 track even when track 1 precedes it", () => {
    expect(parseIntercardSwipe("%P6283=7496003776810700729?;6283=0000000001037356?")).toBe(
      "0000000001037356",
    );
  });

  it("tolerates a stripped end sentinel", () => {
    expect(parseIntercardSwipe(";6283=0000000001037356")).toBe("0000000001037356");
  });

  it("rejects non-Intercard tracks (bank/gift cards, noise)", () => {
    expect(parseIntercardSwipe(";4111111111111111=29051010000000000000?")).toBeNull();
    expect(parseIntercardSwipe(";6039001122334455=0000?")).toBeNull();
    expect(parseIntercardSwipe("6283 no sentinel")).toBeNull();
    expect(parseIntercardSwipe("")).toBeNull();
  });
});

describe("parseSquareGiftSwipe", () => {
  it("discards UnionPay / Mir / Maestro PANs (review 2026-07-29 IIN additions)", () => {
    expect(parseSquareGiftSwipe(";6200000000000005=2905?")).toBeNull(); // UnionPay
    expect(parseSquareGiftSwipe(";6759649826438453=2905?")).toBeNull(); // Maestro UK
    expect(parseSquareGiftSwipe(";2200123456789019=2905?")).toBeNull(); // Mir
  });

  it("classifies a one-chunk two-track Game Zone burst as gamezone", () => {
    expect(parseSquareGiftSwipe("%P6283=7496001?;6283=7496001?")).toEqual({ kind: "gamezone" });
  });
  // Bank-shaped = 13–19 digits AND Luhn-valid AND a payment IIN — discarded
  // before anything can treat the run as a candidate.
  it("hard-discards bank-card track bursts (Visa/MC/Amex/Discover)", () => {
    expect(parseSquareGiftSwipe(";4111111111111111=29051010000000000000?")).toBeNull();
    expect(parseSquareGiftSwipe(";5555555555554444=2905101?\r\n")).toBeNull();
    expect(parseSquareGiftSwipe(";378282246310005=2905?")).toBeNull();
    expect(parseSquareGiftSwipe(";6011111111111117=2905?")).toBeNull();
  });

  it("hard-discards bare bank PANs and the extended IIN ranges (2-series MC, JCB, Diners, 644x)", () => {
    expect(parseSquareGiftSwipe("4111111111111111")).toBeNull();
    expect(parseSquareGiftSwipe(";2223003122003222=2905?")).toBeNull();
    expect(parseSquareGiftSwipe(";3530111333300000=2905?")).toBeNull();
    expect(parseSquareGiftSwipe(";30569309025904=2905?")).toBeNull();
    expect(parseSquareGiftSwipe(";6440001111111111=2905?")).toBeNull();
  });

  it("passes a Luhn-valid 16-digit NON-bank number — Square GANs are often Luhn-valid", () => {
    // Only the payment IIN ranges make a number bank-shaped; Luhn alone must not.
    expect(parseSquareGiftSwipe(";7783320012345674=00000000?")).toEqual({
      kind: "candidate",
      gan: "7783320012345674",
    });
    expect(parseSquareGiftSwipe("7783998877665540\r")).toEqual({
      kind: "candidate",
      gan: "7783998877665540",
    });
  });

  it("recognises an Intercard swipe as a Game Zone card, not a candidate", () => {
    expect(parseSquareGiftSwipe(";6283=0000000001037356?\r\n")).toEqual({ kind: "gamezone" });
    expect(parseSquareGiftSwipe(";6283=0000000001037356")).toEqual({ kind: "gamezone" });
  });

  it("accepts an 8-20 char alphanumeric bare entry as a candidate", () => {
    expect(parseSquareGiftSwipe("7783A1B2C3D4?\n")).toEqual({
      kind: "candidate",
      gan: "7783A1B2C3D4",
    });
    expect(parseSquareGiftSwipe("12345678")).toEqual({ kind: "candidate", gan: "12345678" });
  });

  it("rejects short runs, over-long runs, and non-track shapes", () => {
    expect(parseSquareGiftSwipe("1234567")).toBeNull(); // 7 chars — too short
    expect(parseSquareGiftSwipe("123456789012345678901")).toBeNull(); // 21 — too long
    expect(parseSquareGiftSwipe("")).toBeNull();
    expect(parseSquareGiftSwipe("%?;?")).toBeNull();
    // A track-1 lead (or any multi-track burst) is not one clean ;-track — a
    // full bank swipe with both tracks dies at the shape gate.
    expect(parseSquareGiftSwipe("%B4111111111111111^TEST/CARD^2905?")).toBeNull();
    expect(parseSquareGiftSwipe("%B4111111111111111^T^?;4111111111111111=2905?")).toBeNull();
  });
});
