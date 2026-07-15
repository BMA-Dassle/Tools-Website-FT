/**
 * Read-only card lookup for the reload page: confirms the card exists and
 * returns its current Tokens / Bonus Tokens / Time for display.
 */
import { GameCardHttpError } from "../errors";
import type { VerifyCardInput } from "../schemas";
import type { VerifyResult } from "../types";
import { verifyAccount, IntercardError } from "../data/intercard";

export async function verifyCard(input: VerifyCardInput): Promise<VerifyResult> {
  try {
    return await verifyAccount(input.accountNumber, input.locationCode);
  } catch (err) {
    if (err instanceof IntercardError) {
      throw new GameCardHttpError(
        503,
        "VERIFY_UNAVAILABLE",
        "We couldn't check that card right now. Please try again in a moment.",
      );
    }
    throw err;
  }
}
