import type { NextRequest } from "next/server";
import { requireSession } from "~/features/account";
import { fetchSavedCards } from "~/features/account/data/customers";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";
import { getGameCardsForCustomer, getGameCardCounts } from "~/features/game-cards/service/my-cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/game-cards/my-cards?customerId=...
 * Signed-in customer's linked game cards (+ live balances), saved payment
 * cards, and per-account game-card counts (for the multi-account picker).
 * `customerId` must be one of the session's Square customers.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const body = await req.json().catch(() => ({}));
    const customerIds = session.squareCustomerIds;
    const requested = typeof body?.customerId === "string" ? body.customerId : customerIds[0];

    const counts = await getGameCardCounts(customerIds);

    if (!requested) {
      // No Square customer on file yet (verified phone, no account).
      return jsonOk({ customerId: null, customerIds, counts, gameCards: [], savedCards: [] });
    }
    if (!customerIds.includes(requested)) {
      throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
    }

    const [gameCards, savedCards] = await Promise.all([
      getGameCardsForCustomer(requested),
      fetchSavedCards(requested),
    ]);
    return jsonOk({ customerId: requested, customerIds, counts, gameCards, savedCards });
  } catch (err) {
    return toErrorResponse(err);
  }
}
