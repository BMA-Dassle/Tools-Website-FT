import type { NextRequest } from "next/server";
import { requireSession, requireCsrf } from "~/features/account";
import { createRewardsAccount } from "~/features/game-cards/service/create-account";
import { jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/game-cards/create-account — create a HeadPinz Rewards account
 * (Square customer + best-effort Loyalty) for the signed-in guest. The UI asks
 * the guest first; this performs it and re-binds the session.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const { customerId } = await createRewardsAccount(session);
    return jsonOk({ ok: true, customerId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
