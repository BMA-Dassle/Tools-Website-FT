import { describe, expect, it } from "vitest";
import { classifyEntryScan, racerHandleFromRaw } from "./classify-entry";
import { classifyScan } from "../checkin/scan";
import { classifyKioskCode } from "../code-entry/classify";

/** A real booking-minted voucher shape (HPW + 8 alphabet chars). */
const HPW = "HPWZ96RZ4SX";
/** 24 chars, strict [A-Z][2-9] alternation — the BMI Office shape. */
const BMI_VOUCHER = "C2D8M8D6M6C9M9U9U5K7Q6R9";
/** The 1D barcode on a Game Zone card: account zero-padded to 16. */
const GAME_CARD_BARCODE = "0000000001063464";
/** A real BMI login code — `person.tags[].tag` (verified live 2026-08-03). */
const LOGIN_CODE = "3tn4d694p6z94";
/** The SMS-Timing app's personal QR, exactly as the scanner delivers it. */
const MEMBER_QR = `https://smstim.in?["headpinzftmyers","3f59bc35-0548-46df-ba0c-f8cdedc6568d"]`;

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

  describe("HPW vouchers — our own shape, so redemption without a lookup", () => {
    it("sends a bare HPW code to the voucher screen", () => {
      expect(classifyEntryScan(HPW)).toMatchObject({
        kind: "code-entry",
        value: HPW,
      });
    });

    it("sends the /v/{code} voucher QR to the voucher screen", () => {
      expect(classifyEntryScan(`https://headpinz.com/v/${HPW}`)).toMatchObject({
        kind: "code-entry",
        value: HPW,
      });
    });

    it("normalizes the hyphenated printed form", () => {
      expect(classifyEntryScan("hpw-z96r-z4sx")).toMatchObject({
        kind: "code-entry",
        value: HPW,
      });
    });

    // THE REGRESSION THIS FILE EXISTS TO PREVENT. A booking-minted VIP grant
    // resolves to a real reservation, so while HPW rode `resolve-then-code-
    // entry` the router's `if (res.ok) return toCheckin()` fired on 100% of
    // them — and the voucher receipt is the ONLY screen that names the
    // game-card / laser-tag legs and auto-links the party onto the PERSISTED
    // kiosk session. `code-entry` is not merely one acceptable answer here; a
    // verdict that costs a lookup is the bug.
    it("never emits a verdict that lets a reservation lookup divert a VIP grant", () => {
      for (const payload of [HPW, `https://headpinz.com/v/${HPW}`, "hpw-z96r-z4sx"]) {
        expect(classifyEntryScan(payload).kind).not.toBe("resolve-then-code-entry");
        expect(classifyEntryScan(payload).kind).not.toBe("reservation");
      }
    });
  });

  describe("racer identity — the wallet licence and the SMS-Timing app QR", () => {
    it("routes our /r/{code} licence barcode to the racer path", () => {
      expect(classifyEntryScan(`https://headpinz.com/r/${LOGIN_CODE}`)).toMatchObject({
        kind: "racer",
        value: LOGIN_CODE,
      });
    });

    it("routes the SMS-Timing app QR to the racer path, with its clientKey", () => {
      expect(classifyEntryScan(MEMBER_QR)).toMatchObject({
        kind: "racer",
        value: "3f59bc35-0548-46df-ba0c-f8cdedc6568d",
        clientKey: "headpinzftmyers",
      });
    });

    it("carries NO clientKey for our own barcode — that is what tells them apart", () => {
      const r = classifyEntryScan(`https://headpinz.com/r/${LOGIN_CODE}`);
      expect(r).toMatchObject({ kind: "racer" });
      expect("clientKey" in r && r.clientKey).toBeFalsy();
    });

    it("survives query and fragment on the licence URL", () => {
      expect(classifyEntryScan(`https://headpinz.com/r/${LOGIN_CODE}?utm=wallet`)).toMatchObject({
        kind: "racer",
        value: LOGIN_CODE,
      });
    });

    // THE WHOLE REASON the handle is a URL. A bare login code is 13 alnum
    // chars, which is `SHORT_CODE_RE` — indistinguishable from a reservation
    // short code and from a promo. If someone later "simplifies" this by
    // matching bare codes, they will steal payloads from both neighbours.
    it("does NOT claim a bare login code — that shape belongs to nobody", () => {
      expect(classifyScan(LOGIN_CODE).kind).toBe("shortcode"); // the trap
      expect(classifyKioskCode(LOGIN_CODE).kind).toBe("promo"); // the other trap
      expect(classifyEntryScan(LOGIN_CODE).kind).toBe("resolve-then-code-entry");
    });

    it("does not mistake a voucher deep link for a racer handle", () => {
      expect(racerHandleFromRaw(`https://headpinz.com/v/${HPW}`)).toBeNull();
    });

    it("rejects a foreign host that merely has an /r/ segment", () => {
      // Only the code matters downstream, so a same-shaped path elsewhere is
      // still a racer handle — but a bare relative string never is.
      expect(racerHandleFromRaw(`/r/${LOGIN_CODE}`)).toBeNull();
    });

    it("rejects a malformed member QR rather than passing junk to the search", () => {
      expect(racerHandleFromRaw(`https://smstim.in?["headpinzftmyers"]`)).toBeNull();
      expect(racerHandleFromRaw(`https://smstim.in?not-json`)).toBeNull();
    });

    it("rejects a code with characters the Office token search must never see", () => {
      // Slashes/spaces are what make that upstream 500 under undici, and a
      // `LastName M/D/YYYY` token would turn this into a person-search oracle.
      expect(racerHandleFromRaw("https://headpinz.com/r/Osborn 2/12/1991")).toBeNull();
      expect(racerHandleFromRaw("https://headpinz.com/r/ab")).toBeNull(); // too short
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

    // Every padded digit run goes to Game Zone, whatever its width. A run that
    // is ALSO Groupon-shaped briefly detoured to the code screen so Groupon
    // could be tried first; scanning no longer checks Groupon at all (owner
    // 2026-08-28 — it is typed), so the detour would only delay real card
    // scans. Cards scan anywhere; vouchers scan on the voucher screen.
    it("sends a padded run that is also Groupon-shaped straight to Game Zone", () => {
      expect(classifyEntryScan("000089895632")).toMatchObject({
        kind: "game-card",
        value: "89895632",
      });
    });

    it("sends a full-width Intercard barcode straight to Game Zone", () => {
      expect(classifyEntryScan("0000000001038091")).toMatchObject({
        kind: "game-card",
        value: "1038091",
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
