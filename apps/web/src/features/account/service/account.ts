import { createHash } from "crypto";
import { AccountHttpError } from "../errors";
import { SQUARE_LOCATIONS } from "../constants";
import { fetchSavedCards } from "../data/customers";
import { planInfo } from "../data/catalog";
import { saveCardOnFile } from "../data/cards";
import {
  retrieveSubscription,
  searchSubscriptions,
  updateSubscriptionCard,
} from "../data/subscriptions";
import { assertCardOwned, assertSubscriptionOwned } from "./authorize";
import type { AccountSession, AccountSubscription, BrandKey, SavedCard } from "../types";
import type { AddCardInput, SetCardInput } from "../schemas";

export interface ListResult {
  subscriptions: AccountSubscription[];
  cards: SavedCard[];
}

function dedupeCards(cards: SavedCard[]): SavedCard[] {
  const seen = new Set<string>();
  const out: SavedCard[] = [];
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Aggregate subscriptions + saved cards across all bound customers / 3 locations. */
export async function listSubscriptions(session: AccountSession): Promise<ListResult> {
  const ids = session.squareCustomerIds;
  if (ids.length === 0) return { subscriptions: [], cards: [] };

  const [cardLists, raw] = await Promise.all([
    Promise.all(ids.map((id) => fetchSavedCards(id))),
    searchSubscriptions(ids),
  ]);
  const cards = dedupeCards(cardLists.flat());

  const subscriptions = await Promise.all(
    raw.map(async (s): Promise<AccountSubscription> => {
      const info = await planInfo(s.plan_variation_id);
      const loc = s.location_id ? SQUARE_LOCATIONS[s.location_id] : undefined;
      const card = s.card_id ? cards.find((c) => c.id === s.card_id) : undefined;
      return {
        id: s.id,
        status: s.status || "UNKNOWN",
        planName: info.name,
        locationId: s.location_id || "",
        locationLabel: loc?.label || "Subscription",
        brand: (loc?.brand ?? "fasttrax") as BrandKey,
        customerId: s.customer_id || "",
        cardId: s.card_id || null,
        cardBrand: card?.brand ?? null,
        cardLast4: card?.last4 ?? null,
        version: s.version ?? 0,
        nextBillingDate: s.charged_through_date || null,
        amount: s.price_override_money?.amount ?? info.amount ?? null,
        cadence: info.cadence,
      };
    }),
  );

  return { subscriptions, cards };
}

export interface AddedCard {
  id: string;
  brand: string;
  last4: string;
  customerId: string;
}

/** Save a new card. Target customer is derived server-side (never client-supplied). */
export async function addCard(session: AccountSession, input: AddCardInput): Promise<AddedCard> {
  let customerId: string;
  if (input.forSubscriptionId) {
    const sub = await assertSubscriptionOwned(session, input.forSubscriptionId);
    customerId = sub.customer_id as string;
  } else if (session.squareCustomerIds.length > 0) {
    customerId = session.squareCustomerIds[0];
  } else {
    throw new AccountHttpError(
      409,
      "NO_CUSTOMER",
      "There's no account on file to attach a card to.",
    );
  }

  // Deterministic key (≤45 chars) so a double-submit dedupes at Square.
  const idem = `acct-card-${createHash("sha1")
    .update(`${session.sid}:${input.cardToken}`)
    .digest("hex")
    .slice(0, 32)}`;

  const res = await saveCardOnFile({
    customerId,
    cardToken: input.cardToken,
    verificationToken: input.verificationToken,
    idempotencyKey: idem,
  });
  if (!res.ok || !res.cardId) {
    throw new AccountHttpError(400, "CARD_SAVE_FAILED", res.error || "Couldn't save that card.");
  }
  return { id: res.cardId, brand: res.brand || "Card", last4: res.last4 || "", customerId };
}

export interface UpdatedSubscription {
  id: string;
  cardBrand: string | null;
  cardLast4: string | null;
  version: number;
}

/** Change which saved card pays a subscription. Ownership + version-conflict safe. */
export async function setSubscriptionCard(
  session: AccountSession,
  subscriptionId: string,
  input: SetCardInput,
): Promise<UpdatedSubscription> {
  const sub = await assertSubscriptionOwned(session, subscriptionId);
  const card = await assertCardOwned(session, input.cardId, sub.customer_id as string);
  if (card.expired) {
    throw new AccountHttpError(400, "CARD_EXPIRED", "That card is expired. Add a different card.");
  }

  let version = sub.version ?? 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await updateSubscriptionCard(subscriptionId, input.cardId, version);
    if (res.ok && res.subscription) {
      return {
        id: subscriptionId,
        cardBrand: card.brand,
        cardLast4: card.last4,
        version: res.subscription.version ?? version,
      };
    }
    if (res.status === 409) {
      // Square bumped the version (billing engine / webhook). Re-read once, retry.
      const fresh = await retrieveSubscription(subscriptionId);
      if (fresh?.customer_id && session.squareCustomerIds.includes(fresh.customer_id)) {
        version = fresh.version ?? version;
        continue;
      }
    }
    throw new AccountHttpError(
      res.status === 409 ? 409 : 400,
      res.status === 409 ? "VERSION_CONFLICT" : "UPDATE_FAILED",
      res.error || "Couldn't update the payment card.",
    );
  }
  throw new AccountHttpError(409, "VERSION_CONFLICT", "Please refresh and try again.");
}
