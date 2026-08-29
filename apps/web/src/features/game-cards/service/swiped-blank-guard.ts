/**
 * Server-side twin of the kiosk's "is this swiped card a blank?" check.
 *
 * On a kiosk WITHOUT a dispenser (owner 2026-08-28) the guest takes a blank
 * from the holder under the screen and swipes it; the kiosk verifies it blank
 * and sends the account with the new-card item. That is a CLAIM the browser is
 * making about somebody's card, and money moves on it — a "new card" package
 * plus the activation fee. The server must not take it on faith: re-read the
 * account through the same rule (blank-card.ts) BEFORE any row is persisted or
 * a reader is armed, and refuse a card that already carries value. Refusal is
 * free here — nothing has been charged yet — and cheap: one read per swiped
 * card, 1–10 per basket.
 *
 * Dispenser kiosks never reach this (their items carry no account).
 */
import { GameCardHttpError } from "../errors";
import { classifySwipedCard } from "../blank-card";
import { verifyAccount, IntercardError } from "../data/intercard";

const UNAVAILABLE = new GameCardHttpError(
  503,
  "VERIFY_UNAVAILABLE",
  "We couldn't check the card(s) right now. Please try again in a moment.",
);

/**
 * Throws 409 CARD_NOT_BLANK if any account already carries value or history,
 * 503 VERIFY_UNAVAILABLE if Intercard couldn't confirm (an "unknown" verdict
 * is never sold as new). Resolves when every account is a confirmed blank.
 */
export async function assertSwipedBlanks(
  accountNumbers: readonly string[],
  locationCode: number,
): Promise<void> {
  for (const acct of accountNumbers) {
    let verdict: ReturnType<typeof classifySwipedCard>;
    try {
      verdict = classifySwipedCard(await verifyAccount(acct, locationCode));
    } catch (err) {
      if (err instanceof IntercardError) throw UNAVAILABLE;
      throw err;
    }
    if (verdict === "active") {
      throw new GameCardHttpError(
        409,
        "CARD_NOT_BLANK",
        `Card ${acct.replace(/^0+(?=\d)/, "")} already has value on it — reload it instead of buying it as a new card.`,
      );
    }
    if (verdict === "unknown") throw UNAVAILABLE;
  }
}
