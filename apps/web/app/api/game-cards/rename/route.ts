import type { NextRequest } from "next/server";
import { requireSession, requireCsrf } from "~/features/account";
import { RenameCardSchema } from "~/features/game-cards/schemas";
import { renameGameCard } from "~/features/game-cards/service/my-cards";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/game-cards/rename — set/clear the nickname on a saved game card. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const parsed = RenameCardSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new GameCardHttpError(400, "INVALID_INPUT", "Invalid nickname.");
    if (!session.squareCustomerIds.includes(parsed.data.customerId)) {
      throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
    }
    await renameGameCard(parsed.data.customerId, parsed.data.accountNumber, parsed.data.nickname);
    return jsonOk({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
