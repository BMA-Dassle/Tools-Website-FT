/**
 * Decline copy — the two voices and the parity between them.
 *
 * Written after 2026-08-03, when a live deal-pack checkout took a real
 * `TRANSACTION_LIMIT` from the issuer and told the buyer only "We couldn't process
 * that card. Please try another." The deals feature had its own private table that
 * didn't know the code. These tests pin the shape that prevents a repeat.
 */

import { describe, expect, it } from "vitest";
import {
  checkoutDeclineMessage,
  friendlyDeclineMessage,
  isCardDeclineCode,
} from "../square-decline";

/** The generic sentence a buyer must not be left with when we know the reason. */
const CHECKOUT_FALLBACK = "We couldn't process that card. Please try another.";

/**
 * Every code the module claims to know. Kept as a literal list rather than exported
 * from the module so that deleting a code from the table breaks a test instead of
 * silently shrinking the coverage this file thinks it has.
 */
const KNOWN_CODES = [
  "CARD_DECLINED",
  "GENERIC_DECLINE",
  "CARD_DECLINED_CALL_ISSUER",
  "CARD_DECLINED_VERIFICATION_REQUIRED",
  "INSUFFICIENT_FUNDS",
  "CVV_FAILURE",
  "ADDRESS_VERIFICATION_FAILURE",
  "INVALID_POSTAL_CODE",
  "INVALID_EXPIRATION",
  "EXPIRATION_FAILURE",
  "CARD_EXPIRED",
  "CARD_NOT_SUPPORTED",
  "INVALID_CARD",
  "INVALID_CARD_DATA",
  "PAN_FAILURE",
  "TRANSACTION_LIMIT",
  "CARDHOLDER_INSUFFICIENT_PERMISSIONS",
  "MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED",
  "AMOUNT_TOO_HIGH",
  "INVALID_ACCOUNT",
  "ACCOUNT_UNUSABLE",
  "ALLOWABLE_PIN_TRIES_EXCEEDED",
  "CARD_TOKEN_EXPIRED",
  "CARD_TOKEN_USED",
  "TEMPORARY_ERROR",
  "PAYMENT_LIMIT_EXCEEDED",
  "INSUFFICIENT_PERMISSIONS",
] as const;

describe("checkoutDeclineMessage", () => {
  it("explains TRANSACTION_LIMIT instead of falling back to 'try another'", () => {
    const msg = checkoutDeclineMessage("TRANSACTION_LIMIT");
    expect(msg).not.toBe(CHECKOUT_FALLBACK);
    expect(msg).toMatch(/bank/i);
    // The actionable half: a different card, or a call to the issuer.
    expect(msg).toMatch(/different card/i);
  });

  it("never leaks Square's raw detail to a buyer", () => {
    // The on-file voice DOES fall back to Square's detail; the checkout voice must not,
    // because that string reads "Authorization error: 'TRANSACTION_LIMIT'".
    expect(checkoutDeclineMessage("SOME_UNMAPPED_CODE")).toBe(CHECKOUT_FALLBACK);
    expect(checkoutDeclineMessage(null)).toBe(CHECKOUT_FALLBACK);
    expect(checkoutDeclineMessage(undefined)).toBe(CHECKOUT_FALLBACK);
  });

  it("never says 'card on file' — the buyer just typed it", () => {
    for (const code of KNOWN_CODES) {
      expect(checkoutDeclineMessage(code).toLowerCase()).not.toContain("card on file");
    }
  });

  it("tells the buyer what to do next for every code it knows", () => {
    for (const code of KNOWN_CODES) {
      const msg = checkoutDeclineMessage(code);
      expect(msg, `${code} has no instruction`).toMatch(
        /please|call your bank|call the number|give us a call/i,
      );
    }
  });
});

describe("friendlyDeclineMessage (card-on-file voice)", () => {
  it("keeps the on-file phrasing distinct from the checkout phrasing", () => {
    expect(friendlyDeclineMessage("CARD_EXPIRED")).toBe("The card on file has expired.");
    expect(checkoutDeclineMessage("CARD_EXPIRED")).toBe(
      "That card has expired. Please use a different card.",
    );
  });

  it("still falls back to Square's detail for an unknown code", () => {
    expect(friendlyDeclineMessage("WHO_KNOWS", "Something Square said")).toBe(
      "Something Square said",
    );
    expect(friendlyDeclineMessage("WHO_KNOWS", null)).toBe("The card on file couldn't be charged.");
  });
});

describe("voice parity", () => {
  it("phrases every known code in BOTH voices", () => {
    for (const code of KNOWN_CODES) {
      expect(friendlyDeclineMessage(code, null), `${code} missing on-file copy`).not.toBe(
        "The card on file couldn't be charged.",
      );
      expect(checkoutDeclineMessage(code), `${code} missing checkout copy`).not.toBe(
        CHECKOUT_FALLBACK,
      );
    }
  });
});

describe("isCardDeclineCode", () => {
  it("treats an issuer limit as a card decline", () => {
    expect(isCardDeclineCode("TRANSACTION_LIMIT")).toBe(true);
    expect(isCardDeclineCode("CARDHOLDER_INSUFFICIENT_PERMISSIONS")).toBe(true);
  });

  it("does NOT blame the guest's card for OUR account limits", () => {
    // The GF dunning path gates on this. "Your card was declined" is a lie when the
    // truth is our own Square processing limit.
    expect(isCardDeclineCode("PAYMENT_LIMIT_EXCEEDED")).toBe(false);
    expect(isCardDeclineCode("INSUFFICIENT_PERMISSIONS")).toBe(false);
  });

  it("ignores empty codes", () => {
    expect(isCardDeclineCode(null)).toBe(false);
    expect(isCardDeclineCode("")).toBe(false);
  });
});
