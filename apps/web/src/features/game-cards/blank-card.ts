/**
 * Is the card a guest just SWIPED a blank we may sell as a NEW card — or a
 * card that already carries value?
 *
 * Kiosks without a dispenser (owner 2026-08-28) sell new cards by having the
 * guest take a blank from the holder under the screen and swipe it. The
 * dispenser rail never had to ask this question: whatever comes out of the
 * stacker IS the new card. Here the guest picks the card, so the flow must
 * refuse a card that already has tokens on it (they'd be paying a $2
 * activation to reload their own card, and the flow's copy would lie) and
 * must NOT trust a lookup that merely failed.
 *
 * One pure rule, shared by every caller (the new-card cart, the voucher run,
 * the confirmation-screen fulfilment) so they can never disagree:
 *
 *   blank   — Intercard CONFIRMED there is no account (a blank has none until
 *             its first credit — see intercard.ts clearAccount), or the account
 *             exists with every balance at zero and no history (recycled,
 *             zero-value stock).
 *   active  — any balance component > 0 (tokens, bonus, eTickets, time, or
 *             cash), or any transaction on record.
 *   unknown — the lookup could not say: ambiguous result code, missing balance
 *             block. Callers treat this as "swipe it again", never as blank.
 *
 * Live signature (probed 2026-08-28): Intercard answers result 1 for an
 * account it has never seen — that is the "confirmed" not-found verifyAccount
 * reports; -1 (server exception) is "ambiguous".
 *
 * Money safety does NOT hang on this rule: a swiped card is never
 * clear-on-encoded (load-card.ts), so a misclassification costs wrong copy,
 * not a wiped balance.
 */
import type { VerifyResult } from "./types";

export type SwipedCardClass = "blank" | "active" | "unknown";

export function classifySwipedCard(
  v: Pick<VerifyResult, "exists" | "balance" | "transactions" | "notFound" | "cashBalance">,
): SwipedCardClass {
  if (!v.exists) return v.notFound === "confirmed" ? "blank" : "unknown";
  const b = v.balance;
  if (!b) return "unknown"; // exists but nothing we could inspect — don't guess
  const hasValue =
    b.tokens > 0 ||
    b.bonusTokens > 0 ||
    b.eTickets > 0 ||
    b.timeMinutes > 0 ||
    (v.cashBalance ?? 0) > 0;
  const hasHistory = (v.transactions?.length ?? 0) > 0;
  return hasValue || hasHistory ? "active" : "blank";
}
