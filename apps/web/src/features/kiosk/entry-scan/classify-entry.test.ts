import { describe, expect, it } from "vitest";
import { classifyEntryScan } from "./classify-entry";
import { classifyScan } from "../checkin/scan";
import { classifyKioskCode } from "../code-entry/classify";

/** A real booking-minted voucher shape (HPW + 8 alphabet chars). */
const HPW = "HPWZ96RZ4SX";
/** 24 chars, strict [A-Z][2-9] alternation — the BMI Office shape. */
const BMI_VOUCHER = "C2D8M8D6M6C9M9U9U5K7Q6R9";
/** The 1D barcode on a Game Zone card: account zero-padded to 16. */
const GAME_CARD_BARCODE = "0000000001063464";

describe("classifyEntryScan", () => {
  describe("the four collisions that make a single classifier wrong", () => {
    // Each case asserts BOTH that the router is right AND that the naive
    // single-classifier answer is wrong — so if someone later "simplifies"
    // this to one classifier, these fail loudly instead of silently
    // misrouting guests.

    it("routes a game-card barcode to Game Zone, not a reservation shortcode", () => {
      expect(classifyScan(GAME_CARD_BARCODE).kind).toBe("shortcode"); // the trap
      expect(classifyEntryScan(GAME_CARD_BARCODE)).toMatchObject({
        kind: "game-card",
        value: "1063464", // zero padding stripped, still a string
      });
    });

    it("routes a promo code to the code screen, not a reservation shortcode", () => {
      expect(classifyScan("SUMMER26").kind).toBe("shortcode"); // the trap
      expect(classifyEntryScan("SUMMER26").kind).toBe("resolve-then-code-entry");
    });

    it("routes a BMI voucher to the code screen, not an opaque reservation code", () => {
      expect(classifyScan(BMI_VOUCHER).kind).toBe("code"); // the trap
      expect(classifyEntryScan(BMI_VOUCHER)).toMatchObject({
        kind: "code-entry",
        value: BMI_VOUCHER,
      });
    });

    it("routes a W-number to check-in, not a promo code", () => {
      expect(classifyKioskCode("W56444").kind).toBe("promo"); // the trap
      expect(classifyEntryScan("W56444")).toMatchObject({
        kind: "reservation",
        value: "W56444",
      });
    });
  });

  describe("reservations", () => {
    it("takes a /s short link as a certain reservation", () => {
      expect(classifyEntryScan("https://fasttraxent.com/s/ab12cd")).toMatchObject({
        kind: "reservation",
        value: "ab12cd",
      });
    });

    it("takes a signed confirmation URL as a certain reservation", () => {
      const url = "https://fasttraxent.com/book/confirmation/v2?billId=1234567890123456&sig=abc123";
      expect(classifyEntryScan(url)).toMatchObject({
        kind: "reservation",
        value: "1234567890123456",
      });
    });

    it("uppercases a lowercase W-number", () => {
      expect(classifyEntryScan("w56444")).toMatchObject({ kind: "reservation", value: "W56444" });
    });

    it("sends the r{billId} fallback code down the resolve path", () => {
      // Enumerable, so the lookup route OTP-gates it; either way it must not
      // dead-end as a promo.
      expect(classifyEntryScan("r1234567890123456").kind).toBe("resolve-then-code-entry");
    });
  });

  describe("HPW vouchers — bill_id decides, so the server must resolve", () => {
    it("sends a bare HPW code down the resolve path", () => {
      expect(classifyEntryScan(HPW)).toMatchObject({
        kind: "resolve-then-code-entry",
        value: HPW,
      });
    });

    it("sends the /v/{code} voucher QR down the resolve path", () => {
      expect(classifyEntryScan(`https://headpinz.com/v/${HPW}`)).toMatchObject({
        kind: "resolve-then-code-entry",
        value: HPW,
      });
    });

    it("normalizes the hyphenated printed form", () => {
      expect(classifyEntryScan("hpw-z96r-z4sx")).toMatchObject({
        kind: "resolve-then-code-entry",
        value: HPW,
      });
    });
  });

  describe("game cards", () => {
    it("reads the icardinc QR shortlink", () => {
      const r = classifyEntryScan("https://icardinc.net/abc123");
      expect(r.kind).toBe("game-card");
    });

    it("reads an MSR track-2 burst", () => {
      expect(classifyEntryScan(";6283=1063464?")).toMatchObject({
        kind: "game-card",
        value: "1063464",
      });
    });

    it("reads a reload deep-link carrying ?id=", () => {
      expect(classifyEntryScan("https://swflpassport.com/?id=1063464")).toMatchObject({
        kind: "game-card",
        value: "1063464",
      });
    });
  });

  describe("coupon QRs recurse into their inner code", () => {
    it("pulls ?code= out of a booking URL", () => {
      expect(classifyEntryScan("https://headpinz.com/book/v2?code=SUMMER26").kind).toBe(
        "resolve-then-code-entry",
      );
    });
  });

  describe("unsupported — brief toast, stay put", () => {
    it("rejects a Square gift card QR", () => {
      expect(classifyEntryScan("sqgc://7783324218120014")).toMatchObject({
        kind: "unsupported",
        reason: "gift-card",
      });
    });

    it("rejects a printed Square balance URL", () => {
      expect(classifyEntryScan("https://squareup.com/gift/balance/tok_abc")).toMatchObject({
        kind: "unsupported",
        reason: "gift-card",
      });
    });

    it("rejects a single-line driver's licence payload", () => {
      expect(classifyEntryScan("@\rANSI 636010090002DL00410269DLDAQT64235789")).toMatchObject({
        kind: "unsupported",
        reason: "license",
      });
    });

    it("rejects an unrelated URL", () => {
      expect(classifyEntryScan("https://example.com/hello")).toMatchObject({
        kind: "unsupported",
        reason: "unknown",
      });
    });

    it("rejects empty and whitespace-only input", () => {
      expect(classifyEntryScan("")).toMatchObject({ kind: "unsupported", reason: "unknown" });
      expect(classifyEntryScan("   ")).toMatchObject({ kind: "unsupported", reason: "unknown" });
    });
  });

  it("always echoes the trimmed raw payload back", () => {
    expect(classifyEntryScan("  W56444  ").raw).toBe("W56444");
  });
});
