import type { NextRequest } from "next/server";
import { requireSession, requireCsrf } from "~/features/account";
import { LinkCardSchema } from "~/features/game-cards/schemas";
import { linkGameCard } from "~/features/game-cards/service/my-cards";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/game-cards/link — associate a game card with the selected Square customer. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const parsed = LinkCardSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new GameCardHttpError(400, "INVALID_INPUT", "Invalid card details.");
    if (!session.squareCustomerIds.includes(parsed.data.customerId)) {
      throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
    }
    const card = await linkGameCard(parsed.data);
    return jsonOk({ ok: true, card });
  } catch (err) {
    return toErrorResponse(err);
  }
}
