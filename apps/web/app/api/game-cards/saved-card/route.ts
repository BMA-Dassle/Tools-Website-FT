import type { NextRequest } from "next/server";
import { requireSession, requireCsrf } from "~/features/account";
import { fetchSavedCards } from "~/features/account/data/customers";
import { disableCard } from "~/features/account/data/cards";
import { DisableSavedCardSchema } from "~/features/game-cards/schemas";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/game-cards/saved-card — remove (disable) a saved payment card. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const parsed = DisableSavedCardSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new GameCardHttpError(400, "INVALID_INPUT", "Invalid request.");
    const { customerId, cardId } = parsed.data;
    if (!session.squareCustomerIds.includes(customerId)) {
      throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
    }
    // Confirm the card actually belongs to that customer before disabling.
    const cards = await fetchSavedCards(customerId);
    if (!cards.some((c) => c.id === cardId)) {
      throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
    }
    const res = await disableCard(cardId);
    if (!res.ok) throw new GameCardHttpError(502, "DISABLE_FAILED", "Couldn't remove the card.");
    return jsonOk({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
