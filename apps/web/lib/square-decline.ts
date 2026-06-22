/**
 * Map a Square payment error code (errors[0].code on a 402 / declined charge) to a
 * short, guest-friendly explanation. Used to persist + display WHY a balance card
 * charge was declined and to phrase the card-declined email/SMS.
 *
 * Square codes: https://developer.squareup.com/reference/square/objects/Error
 * We keep the copy non-judgmental and action-oriented ("try a different card") since
 * the guest can't always fix issuer-side declines.
 */

const FRIENDLY: Record<string, string> = {
  CARD_DECLINED: "Your bank declined the charge.",
  GENERIC_DECLINE: "Your bank declined the charge.",
  CARD_DECLINED_CALL_ISSUER:
    "Your bank declined the charge and asked that you call them to approve it.",
  CARD_DECLINED_VERIFICATION_REQUIRED:
    "Your bank needs to verify this charge. Please use a different card or contact your bank.",
  INSUFFICIENT_FUNDS: "The card had insufficient funds for this charge.",
  CVV_FAILURE: "The card's security code (CVV) didn't match.",
  ADDRESS_VERIFICATION_FAILURE: "The billing ZIP/postal code didn't match the card.",
  INVALID_EXPIRATION: "The card's expiration date was invalid.",
  EXPIRATION_FAILURE: "The card's expiration date was invalid.",
  CARD_EXPIRED: "The card on file has expired.",
  CARD_NOT_SUPPORTED: "That card type isn't supported. Please try a different card.",
  INVALID_CARD: "The card details were invalid.",
  INVALID_CARD_DATA: "The card details were invalid.",
  TRANSACTION_LIMIT: "The charge exceeded the card's transaction limit.",
  TEMPORARY_ERROR: "A temporary processing error occurred. Please try again.",
  PAN_FAILURE: "The card number was invalid.",
  ALLOWABLE_PIN_TRIES_EXCEEDED:
    "The card was locked after too many attempts. Please use a different card.",
};

const FALLBACK = "The card on file couldn't be charged.";

/** Guest-friendly one-liner for a Square decline code (+ optional Square detail). */
export function friendlyDeclineMessage(
  code: string | null | undefined,
  detail?: string | null,
): string {
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  // Fall back to Square's own detail when it's present and human-readable, else generic.
  if (detail && detail.length <= 140 && /[a-z]/i.test(detail)) return detail;
  return FALLBACK;
}

/** True when a Square error code represents an issuer/card decline (vs a system error). */
export function isCardDeclineCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return (
    code in FRIENDLY || code.includes("DECLIN") || code.includes("CARD") || code.includes("CVV")
  );
}
