/**
 * Map a Square payment error code (errors[0].code on a 402 / declined charge) to a
 * short, guest-friendly explanation.
 *
 * Square codes: https://developer.squareup.com/reference/square/enums/ErrorCode
 * We keep the copy non-judgmental and action-oriented ("try a different card") since
 * the guest can't always fix issuer-side declines.
 *
 * TWO VOICES, ONE CODE TABLE. The same Square code has to be phrased differently
 * depending on where it is read:
 *
 *   ON_FILE  — a card WE hold, charged in the background (the GF balance sweep, the
 *              card-declined email/SMS). Nobody is at a keyboard; "the card on file"
 *              is the right noun and there is nothing to re-enter right now.
 *   CHECKOUT — the guest just typed a card and is staring at the form. The sentence
 *              has to say what to DO next: re-enter it, use a different card, call
 *              the bank.
 *
 * They live in one file because a code learned in one context must never be missing
 * from the other. `CHECKOUT` is typed against `keyof typeof ON_FILE`, so adding a code
 * to one voice and forgetting the other fails `tsc`.
 *
 * WHY THIS EXISTS AS A SHARED MODULE: the deals checkout shipped its own private
 * seven-code table and silently lacked `TRANSACTION_LIMIT`. On 2026-08-03 a real
 * issuer decline on a live purchase rendered as "We couldn't process that card. Please
 * try another." — no reason given — and the buyer dutifully retried the same doomed
 * card four times in three minutes. A decline the guest cannot act on is a lost sale.
 */

/**
 * Copy for a card we hold and charge without the guest present.
 *
 * `as const satisfies` (rather than a bare `Record<string, string>`) is what gives
 * `CHECKOUT` its key type — that is the parity guard, so don't loosen it.
 */
const ON_FILE = {
  CARD_DECLINED: "Your bank declined the charge.",
  GENERIC_DECLINE: "Your bank declined the charge.",
  CARD_DECLINED_CALL_ISSUER:
    "Your bank declined the charge and asked that you call them to approve it.",
  CARD_DECLINED_VERIFICATION_REQUIRED:
    "Your bank needs to verify this charge. Please use a different card or contact your bank.",
  INSUFFICIENT_FUNDS: "The card had insufficient funds for this charge.",
  CVV_FAILURE: "The card's security code (CVV) didn't match.",
  ADDRESS_VERIFICATION_FAILURE: "The billing ZIP/postal code didn't match the card.",
  INVALID_POSTAL_CODE: "The billing ZIP/postal code wasn't in a valid format.",
  INVALID_EXPIRATION: "The card's expiration date was invalid.",
  EXPIRATION_FAILURE: "The card's expiration date was invalid.",
  CARD_EXPIRED: "The card on file has expired.",
  CARD_NOT_SUPPORTED: "That card type isn't supported. Please try a different card.",
  INVALID_CARD: "The card details were invalid.",
  INVALID_CARD_DATA: "The card details were invalid.",
  PAN_FAILURE: "The card number was invalid.",
  // Square: "the card issuer has determined the payment amount is either too high or
  // too low" — it is NOT necessarily a ceiling, so the copy stays direction-neutral.
  TRANSACTION_LIMIT: "The bank wouldn't approve an amount this size on that card.",
  // Square: "restrictions on where the card can be used" — a spend control, not a balance.
  CARDHOLDER_INSUFFICIENT_PERMISSIONS:
    "The bank doesn't allow that card to be used for this kind of charge.",
  MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED:
    "That card can't be charged unless it's physically present.",
  AMOUNT_TOO_HIGH: "The amount was too high for that card.",
  INVALID_ACCOUNT: "The bank couldn't find that account.",
  ACCOUNT_UNUSABLE: "That account can't be used for payments.",
  ALLOWABLE_PIN_TRIES_EXCEEDED:
    "The card was locked after too many attempts. Please use a different card.",
  CARD_TOKEN_EXPIRED: "We couldn't use the saved card. Please re-enter it.",
  CARD_TOKEN_USED: "We couldn't use the saved card. Please re-enter it.",
  TEMPORARY_ERROR: "A temporary processing error occurred. Please try again.",
  // ── the two below are OUR account, not the guest's card. See MERCHANT_SIDE. ──
  PAYMENT_LIMIT_EXCEEDED: "We couldn't process a charge that size. Please give us a call.",
  INSUFFICIENT_PERMISSIONS: "We couldn't process that charge. Please give us a call.",
} as const satisfies Record<string, string>;

/** Every Square code either voice knows how to phrase. */
type DeclineCode = keyof typeof ON_FILE;

/**
 * Copy for a guest at a live checkout, who can act on the answer this second.
 *
 * Every line ends in an instruction. "Please try another" with no reason is what
 * produced the four-retry incident this module was written for.
 */
const CHECKOUT: Record<DeclineCode, string> = {
  CARD_DECLINED: "Your bank declined the charge. Please try a different card.",
  GENERIC_DECLINE: "Your bank declined the charge. Please try a different card.",
  CARD_DECLINED_CALL_ISSUER:
    "Your bank declined it and asked you to call them. Call the number on the back of the card, or use a different one.",
  CARD_DECLINED_VERIFICATION_REQUIRED:
    "Your bank needs to verify this charge. Please use a different card or contact your bank.",
  INSUFFICIENT_FUNDS: "The card has insufficient funds. Please try a different card.",
  CVV_FAILURE: "The security code (CVV) didn't match. Please check it and try again.",
  ADDRESS_VERIFICATION_FAILURE:
    "The billing ZIP didn't match the card. Please check it and try again.",
  INVALID_POSTAL_CODE: "That ZIP code isn't formatted correctly. Please re-enter it.",
  INVALID_EXPIRATION: "That expiration date isn't valid. Please check it and try again.",
  EXPIRATION_FAILURE: "That expiration date isn't valid. Please check it and try again.",
  CARD_EXPIRED: "That card has expired. Please use a different card.",
  CARD_NOT_SUPPORTED: "That card type isn't supported here. Please try a different card.",
  INVALID_CARD: "Those card details didn't check out. Please re-enter them.",
  INVALID_CARD_DATA: "Those card details didn't check out. Please re-enter them.",
  PAN_FAILURE: "That card number isn't valid. Please check it and try again.",
  TRANSACTION_LIMIT:
    "Your bank won't approve an amount this size on that card. Please use a different card, or call your bank to approve it.",
  CARDHOLDER_INSUFFICIENT_PERMISSIONS:
    "Your bank doesn't allow that card to be used for this purchase. Please try a different card.",
  MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED:
    "That card can't be used for online payments. Please try a different card.",
  AMOUNT_TOO_HIGH: "That amount is too high for this card. Please try a different card.",
  INVALID_ACCOUNT:
    "Your bank couldn't find that account. Please check the number, or use a different card.",
  ACCOUNT_UNUSABLE: "That account can't be used for payments. Please try a different card.",
  ALLOWABLE_PIN_TRIES_EXCEEDED:
    "That card is locked after too many attempts. Please use a different card.",
  CARD_TOKEN_EXPIRED: "That took a little too long. Please re-enter your card and try again.",
  CARD_TOKEN_USED: "That card was already submitted. Please refresh the page and try again.",
  TEMPORARY_ERROR: "A temporary processing error occurred. Please try again.",
  PAYMENT_LIMIT_EXCEEDED: "We can't take a payment this large online. Please give us a call.",
  INSUFFICIENT_PERMISSIONS: "We couldn't take that payment. Please give us a call.",
};

/**
 * Codes that mean OUR Square account refused, not the guest's card.
 *
 * These must never count as a card decline: the GF dunning path uses
 * `isCardDeclineCode` to decide whether to tell a customer their card failed, and
 * "your card was declined" is a lie when the truth is our own processing limit.
 */
const MERCHANT_SIDE: ReadonlySet<string> = new Set<DeclineCode>([
  "PAYMENT_LIMIT_EXCEEDED",
  "INSUFFICIENT_PERMISSIONS",
]);

const ON_FILE_FALLBACK = "The card on file couldn't be charged.";
const CHECKOUT_FALLBACK = "We couldn't process that card. Please try another.";

/**
 * Guest-friendly one-liner for a card WE hold (dunning email/SMS, admin board).
 *
 * Falls back to Square's own `detail` when we don't know the code — that string is
 * terse but accurate, and this copy is read by staff as often as by guests.
 */
export function friendlyDeclineMessage(
  code: string | null | undefined,
  detail?: string | null,
): string {
  if (code && code in ON_FILE) return ON_FILE[code as DeclineCode];
  if (detail && detail.length <= 140 && /[a-z]/i.test(detail)) return detail;
  return ON_FILE_FALLBACK;
}

/**
 * Guest-friendly one-liner for a live checkout, where the buyer just typed the card.
 *
 * Deliberately takes NO `detail` fallback. Square's raw detail reads
 * `Authorization error: 'TRANSACTION_LIMIT'`, which is worse than the generic
 * sentence in front of a buyer mid-purchase.
 */
export function checkoutDeclineMessage(code: string | null | undefined): string {
  if (code && code in CHECKOUT) return CHECKOUT[code as DeclineCode];
  return CHECKOUT_FALLBACK;
}

/** True when a Square error code represents an issuer/card decline (vs a system error). */
export function isCardDeclineCode(code: string | null | undefined): boolean {
  if (!code) return false;
  if (MERCHANT_SIDE.has(code)) return false;
  return (
    code in ON_FILE || code.includes("DECLIN") || code.includes("CARD") || code.includes("CVV")
  );
}
