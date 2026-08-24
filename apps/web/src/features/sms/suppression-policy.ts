/**
 * The send/suppress decision, as a pure function.
 *
 * Split out from the database layer on purpose: this is the rule that
 * decides whether a guest who revoked consent gets texted anyway, and it
 * should be provable by unit test rather than only observable in
 * production.
 *
 * ── Default ALLOW, block on an explicit revocation ──────────────────
 *
 * This is the opposite default from `marketing_consent`, and the
 * difference is the whole point of the transactional-only program.
 * Marketing needs prior express WRITTEN consent, so no row means no.
 * Transactional messages need only prior express consent, which the guest
 * gave by handing us their number for the booking — so no row means yes.
 * `Van Patten v. Vertical Fitness`, 847 F.3d 1037 (9th Cir. 2017): the
 * scope of consent follows the transactional context.
 *
 * Getting this backwards would mean the e-ticket that admits a guest to
 * the track silently not sending, which our own code already records
 * happening once: `kiosk-post-reserve.ts:303` defaults SMS on because
 * "leaving it undefined silently skipped the SMS (W51654 got the email,
 * no text)."
 */

/**
 * Why a message is being sent. Drives whether a revocation can be
 * overridden — and only two categories can override it.
 */
export type SendCategory =
  /** Booking confirmations, e-tickets, check-in alerts, video links,
   *  receipts. The overwhelming majority. Always honors a revocation. */
  | "transactional"
  /** One-time passcodes. The guest asked for this one, seconds ago, by
   *  typing their number into a login box; it is self-evidently
   *  requested and is not an advertisement. Bypasses suppression so a
   *  guest who opted out of texts can still sign in. */
  | "otp"
  /** Safety / operational: evacuation, ride stoppage, "your child's
   *  session ended early". Bypasses suppression because the alternative
   *  is worse than a compliance argument. */
  | "safety"
  /** Promotional. Must ALSO satisfy marketing opt-in, which is a
   *  separate check — this category existing does not authorize a send.
   *  Present so a future promo cannot silently inherit "transactional". */
  | "marketing";

export interface SuppressionState {
  /** True when a revocation is on file for this number. */
  suppressed: boolean;
  /** True when we could not determine the state (DB down, timeout). */
  lookupFailed: boolean;
}

export interface SendDecision {
  allow: boolean;
  /** Machine-readable outcome, for the SMS log and for tests. */
  outcome:
    | "allowed"
    | "blocked_suppressed"
    | "blocked_lookup_failed"
    | "bypassed_suppression"
    | "blocked_marketing_needs_opt_in";
  /** Human-readable, goes into the skip record so ops can see why. */
  reason: string;
  /** True when we sent to a suppressed number under a bypass. Every one
   *  of these must be logged — an unlogged bypass is indistinguishable
   *  from ignoring the revocation. */
  bypassUsed: boolean;
}

/**
 * Decide whether to send.
 *
 * ── Fail CLOSED for ordinary traffic, OPEN for OTP ──────────────────
 *
 * If we cannot read the suppression state, a transactional send is
 * blocked: texting someone who revoked is a statutory violation per
 * message, while not texting them delays a message that also goes by
 * email. An OTP is allowed through, because failing closed there locks a
 * guest out of their own account over an unrelated database blip, and an
 * OTP the guest just requested is the weakest possible violation case.
 */
export function decideSend(category: SendCategory, state: SuppressionState): SendDecision {
  const bypasses = category === "otp" || category === "safety";

  if (state.lookupFailed) {
    if (bypasses) {
      return {
        allow: true,
        outcome: "bypassed_suppression",
        reason: `${category}: suppression lookup failed, failing open`,
        bypassUsed: true,
      };
    }
    return {
      allow: false,
      outcome: "blocked_lookup_failed",
      reason: "suppression lookup failed, failing closed",
      bypassUsed: false,
    };
  }

  if (state.suppressed) {
    if (bypasses) {
      return {
        allow: true,
        outcome: "bypassed_suppression",
        reason: `${category}: sent to a suppressed number under bypass`,
        bypassUsed: true,
      };
    }
    return {
      allow: false,
      outcome: "blocked_suppressed",
      reason: "recipient revoked consent",
      bypassUsed: false,
    };
  }

  // Not suppressed. Marketing still needs its own affirmative opt-in,
  // which lives in `marketing_consent` and is NOT this function's job.
  // Returning a distinct outcome keeps a future promo from mistaking
  // "not suppressed" for "cleared to send".
  if (category === "marketing") {
    return {
      allow: false,
      outcome: "blocked_marketing_needs_opt_in",
      reason: "marketing requires a separate opt-in check",
      bypassUsed: false,
    };
  }

  return { allow: true, outcome: "allowed", reason: "no revocation on file", bypassUsed: false };
}
