import type { NextRequest } from "next/server";
import { requireSession } from "~/features/account";
import { fetchSavedCards } from "~/features/account/data/customers";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";
import {
  getGameCardsForCustomer,
  getAccountsOverview,
  type AccountOverview,
} from "~/features/game-cards/service/my-cards";
import { getLoyaltyPointsByPhone } from "~/features/game-cards/data/square-customer";
import type { LinkedGameCard } from "~/features/game-cards/service/my-cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/game-cards/my-cards { customerId? }
 * Always returns the account picker overview (name/email/cardCount per Square
 * customer) + HeadPinz Rewards points (phone-level). Game cards + saved payment
 * cards are ONLY returned when a specific, owned `customerId` is selected —
 * payment methods stay hidden until the guest picks an account.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const customerIds = session.squareCustomerIds;
    const body = await req.json().catch(() => ({}));
    const requested = typeof body?.customerId === "string" ? body.customerId : null;

    const [accounts, rewardsPoints] = await Promise.all([
      getAccountsOverview(customerIds),
      session.contactType === "phone"
        ? getLoyaltyPointsByPhone(session.contact)
        : Promise.resolve(null),
    ]);

    let selected: string | null = null;
    let gameCards: LinkedGameCard[] = [];
    let savedCards: Awaited<ReturnType<typeof fetchSavedCards>> = [];
    if (requested) {
      if (!customerIds.includes(requested)) {
        throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
      }
      selected = requested;
      [gameCards, savedCards] = await Promise.all([
        getGameCardsForCustomer(requested),
        fetchSavedCards(requested),
      ]);
    }

    return jsonOk({
      customerId: selected,
      customerIds,
      accounts: accounts as AccountOverview[],
      rewardsPoints,
      gameCards,
      savedCards,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
