/**
 * Success-screen poll: per-card load progress for one purchase group. The
 * groupId is a server-minted UUID handed back by /purchase (capability
 * token), so this exposes nothing enumerable. `via` says which door delivered
 * a confirmed load (bridge / soap / …) — diagnostics for staff, never
 * rendered to guests.
 */
import type { NextRequest } from "next/server";
import { LoadStatusSchema } from "~/features/game-cards/schemas";
import { getGroupQueueStates } from "~/features/game-cards/data/transactions-log";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = LoadStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Bad status request.");
    }
    const states = await getGroupQueueStates(parsed.data.groupId);
    return jsonOk({
      ok: true,
      rows: states.map((s) => ({
        txnId: s.txnId,
        accountNumber: s.accountNumber,
        loaded: s.loadState === "loaded",
        tokens: s.tokens,
        bonusTokens: s.bonusTokens,
        via: s.loadedVia,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
