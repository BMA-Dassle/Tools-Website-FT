/**
 * The coupon/voucher receipt's footer decision — extracted so the one place
 * that decides what the primary button does (and whether Back must warn) is
 * plain, testable logic instead of JSX conditionals (owner 2026-07-30: the
 * module kept contradicting itself screen to screen).
 *
 * Inputs are counts/flags only; the component maps the verdict to i18n keys.
 */

export interface ReceiptState {
  /** Distinct voucher codes with game-card legs still undispensed. */
  cardCodes: number;
  /** Whether THIS kiosk can put a new card in the guest's hand: a working
   *  dispenser (capability "full") OR a swipe reader with blank stock
   *  (capability "swipe" — the guest swipes a blank and it loads). */
  canIssue: boolean;
  /** Vouchers on the order (BMI + native cart legs), errored ones included. */
  cartVouchers: number;
  /** A session promo is applied. */
  promoApplied: boolean;
}

export type ReceiptPrimary =
  /** Issue now (dispense, or load a swiped blank) — cards are the only value here. */
  | "print"
  /** Issue now, then return to the order (cart legs exist). */
  | "print-continue"
  /** Nothing issuable HERE (no card hardware) and nothing on an order — leave. */
  | "done"
  /** Order-bound value only (cart vouchers / promo) — go pick activities. */
  | "start-picking";

export interface ReceiptPlan {
  primary: ReceiptPrimary;
  /** Back must interpose the "your cards won't print later" warning. */
  warnOnBack: boolean;
}

export function receiptPlan(s: ReceiptState): ReceiptPlan {
  const issuable = s.canIssue && s.cardCodes > 0;
  if (issuable) {
    return {
      primary: s.cartVouchers > 0 || s.promoApplied ? "print-continue" : "print",
      // Leaving issuable cards behind is the ONE silent-loss path — warn.
      warnOnBack: true,
    };
  }
  // No card hardware (or no cards): nothing this screen itself fulfils, so
  // Back never needs a warning — value either rides the order or is collected
  // elsewhere (the rows say where).
  return {
    primary: s.cartVouchers > 0 || s.promoApplied ? "start-picking" : "done",
    warnOnBack: false,
  };
}
