/**
 * Read a signed-in customer's linked game cards (+ live balances) and manage
 * links. Written to be reusable by BOTH the reload page and the account
 * dashboard (a future "Game Cards" tab): every function takes plain Square
 * customer id(s) — no reload-flow or request coupling — so a caller that has a
 * session's `squareCustomerIds` can render the same data anywhere.
 */
import { GameCardHttpError } from "../errors";
import type { CardBalance } from "../types";
import { verifyAccount, IntercardError } from "../data/intercard";
import {
  linkCard,
  unlinkCard,
  renameCard,
  listCardsForCustomer,
  countsByCustomer,
} from "../data/customer-cards";
import { getCustomerProfiles } from "../data/square-customer";

export interface AccountOverview {
  customerId: string;
  name: string | null;
  email: string | null;
  cardCount: number;
}

/** Per-account summary for the multi-account picker (name/email + linked count). */
export async function getAccountsOverview(customerIds: string[]): Promise<AccountOverview[]> {
  const [profiles, counts] = await Promise.all([
    getCustomerProfiles(customerIds),
    countsByCustomer(customerIds),
  ]);
  return profiles.map((p) => ({ ...p, cardCount: counts[p.customerId] ?? 0 }));
}

export interface LinkedGameCard {
  accountNumber: string;
  label: string | null;
  locationCode: number | null;
  exists: boolean;
  balance?: CardBalance;
}

/** A customer's linked game cards with live balances (parallel lookups). */
export async function getGameCardsForCustomer(customerId: string): Promise<LinkedGameCard[]> {
  const rows = await listCardsForCustomer(customerId);
  return Promise.all(
    rows.map(async (r) => {
      try {
        const v = await verifyAccount(r.accountNumber, r.locationCode ?? undefined);
        return {
          accountNumber: r.accountNumber,
          label: r.label,
          locationCode: r.locationCode,
          exists: v.exists,
          balance: v.balance,
        };
      } catch {
        // Balance service hiccup — still list the card, just without a balance.
        return {
          accountNumber: r.accountNumber,
          label: r.label,
          locationCode: r.locationCode,
          exists: true,
        };
      }
    }),
  );
}

/** Linked-card counts per customer id — for the multi-account picker badges. */
export async function getGameCardCounts(customerIds: string[]): Promise<Record<string, number>> {
  return countsByCustomer(customerIds);
}

/**
 * Link a game card to a customer after confirming it exists (read-only verify).
 * Throws GameCardHttpError so routes map it cleanly.
 */
export async function linkGameCard(params: {
  customerId: string;
  accountNumber: string;
  locationCode?: number;
}): Promise<LinkedGameCard> {
  let exists = false;
  let balance: CardBalance | undefined;
  let name: string | undefined;
  try {
    const v = await verifyAccount(params.accountNumber, params.locationCode);
    exists = v.exists;
    balance = v.balance;
    name = v.name;
  } catch (err) {
    if (err instanceof IntercardError) {
      throw new GameCardHttpError(503, "VERIFY_UNAVAILABLE", "Couldn't check that card right now.");
    }
    throw err;
  }
  if (!exists) {
    throw new GameCardHttpError(400, "CARD_NOT_FOUND", "We couldn't find that card number.");
  }
  // label stays null on link — it's the customer's editable nickname, set via
  // renameGameCard, not the (usually blank) Intercard name. `name` is unused here.
  void name;
  await linkCard({
    squareCustomerId: params.customerId,
    accountNumber: params.accountNumber,
    locationCode: params.locationCode ?? null,
  });
  return {
    accountNumber: params.accountNumber,
    label: null,
    locationCode: params.locationCode ?? null,
    exists: true,
    balance,
  };
}

export async function unlinkGameCard(customerId: string, accountNumber: string): Promise<void> {
  await unlinkCard(customerId, accountNumber);
}

/** Set/clear the customer's nickname for a linked card. */
export async function renameGameCard(
  customerId: string,
  accountNumber: string,
  nickname: string | null,
): Promise<void> {
  const trimmed = nickname?.trim() || null;
  await renameCard(customerId, accountNumber, trimmed);
}
