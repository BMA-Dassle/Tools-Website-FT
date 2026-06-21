import { AccountHttpError } from "../errors";
import { fetchSavedCards } from "../data/customers";
import { retrieveSubscription, type RawSubscription } from "../data/subscriptions";
import type { AccountSession, SavedCard } from "../types";

/**
 * The authorization core. A single Square token can touch the whole merchant,
 * so these ownership rechecks are the ONLY thing separating one customer's data
 * from another's. Client-supplied ids are re-verified against the session's
 * server-derived bound customer ids on every operation. We 404 (not 403) on a
 * mismatch so the response doesn't confirm the id exists.
 */
export async function assertSubscriptionOwned(
  session: AccountSession,
  subscriptionId: string,
): Promise<RawSubscription> {
  const sub = await retrieveSubscription(subscriptionId);
  if (!sub?.customer_id || !session.squareCustomerIds.includes(sub.customer_id)) {
    throw new AccountHttpError(404, "NOT_FOUND", "Subscription not found");
  }
  return sub;
}

/**
 * A card is usable only if it belongs to `customerId` AND that customer is
 * bound to the session. `customerId` is always the subscription's own customer,
 * which enforces card↔subscription customer equality (Square requires it).
 */
export async function assertCardOwned(
  session: AccountSession,
  cardId: string,
  customerId: string,
): Promise<SavedCard> {
  if (!session.squareCustomerIds.includes(customerId)) {
    throw new AccountHttpError(404, "NOT_FOUND", "Card not found");
  }
  const card = (await fetchSavedCards(customerId)).find((c) => c.id === cardId);
  if (!card) throw new AccountHttpError(404, "NOT_FOUND", "Card not found");
  return card;
}
