import type { NextRequest } from "next/server";
import { requireSession, requireCsrf } from "~/features/account";
import { UnlinkCardSchema } from "~/features/game-cards/schemas";
import { unlinkGameCard } from "~/features/game-cards/service/my-cards";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/game-cards/unlink — remove a game card from the selected Square customer. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const parsed = UnlinkCardSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new GameCardHttpError(400, "INVALID_INPUT", "Invalid request.");
    if (!session.squareCustomerIds.includes(parsed.data.customerId)) {
      throw new GameCardHttpError(404, "NOT_FOUND", "Not found");
    }
    await unlinkGameCard(parsed.data.customerId, parsed.data.accountNumber);
    return jsonOk({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
