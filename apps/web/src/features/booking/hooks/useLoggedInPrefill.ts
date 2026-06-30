"use client";

import { useEffect, useRef, type Dispatch } from "react";
import type { Action } from "../state/machine";
import type { BookingSession } from "../state/types";

interface BookingContextResponse {
  contact: { firstName: string; lastName: string; email: string; phone: string };
  squareCustomerId: string | null;
  loyalty: { accountId: string; customerId: string; balance: number; verified: true } | null;
}

/**
 * When a logged-in customer (verified account session) enters the booking flow,
 * seed the booking session from their account so they don't retype contact info
 * and don't re-auth for rewards. Runs ONCE after hydration:
 *
 *  - Contact: fills only EMPTY fields — never clobbers typed input or a
 *    returning-racer pre-fill. Prefilling the phone also makes the existing
 *    checkout auto-resolve their cards on file and loyalty account.
 *  - Loyalty: a phone-typed account session has already proven the number, so we
 *    set `verified: true` directly — LoyaltySection then skips the SMS re-verify.
 *
 * A 401 (not logged in) is the common, silent case — do nothing.
 */
export function useLoggedInPrefill(
  session: BookingSession,
  dispatch: Dispatch<Action>,
  hydrated: boolean,
): void {
  const ran = useRef(false);
  // Snapshot the post-hydration state so the one-shot effect doesn't depend on
  // every keystroke; we only ever fill blanks, so a slightly stale read is safe.
  const contactRef = useRef(session.contact);
  const hasLoyaltyRef = useRef(!!session.loyalty);
  contactRef.current = session.contact;
  hasLoyaltyRef.current = !!session.loyalty;

  useEffect(() => {
    if (!hydrated || ran.current) return;
    ran.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch("/api/account/booking-context", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!res.ok || cancelled) return; // 401 = not logged in → no-op
        const ctx = (await res.json()) as BookingContextResponse;
        if (cancelled) return;

        const c = contactRef.current;
        const patch: Partial<BookingSession["contact"]> = {};
        if (!c.firstName && ctx.contact.firstName) patch.firstName = ctx.contact.firstName;
        if (!c.lastName && ctx.contact.lastName) patch.lastName = ctx.contact.lastName;
        if (!c.email && ctx.contact.email) patch.email = ctx.contact.email;
        if (!c.phone && ctx.contact.phone) patch.phone = ctx.contact.phone;
        if (Object.keys(patch).length > 0) dispatch({ type: "setContact", patch });

        if (ctx.loyalty && !hasLoyaltyRef.current) {
          dispatch({
            type: "setLoyalty",
            loyalty: {
              accountId: ctx.loyalty.accountId,
              customerId: ctx.loyalty.customerId,
              balance: ctx.loyalty.balance,
              verified: true, // account session already proved the phone
              isNewSignup: false,
              selectedRewardTier: null,
            },
          });
        }
      } catch {
        /* network/parse error — prefill is best-effort, never blocks booking */
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
}
