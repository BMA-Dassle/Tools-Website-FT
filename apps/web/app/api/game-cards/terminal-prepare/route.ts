import type { NextRequest } from "next/server";
import { TerminalPrepareSchema } from "~/features/game-cards/schemas";
import { prepareTerminalPurchase } from "~/features/game-cards/service/terminal-purchase";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * KIOSK direct-Terminal PREPARE: verify (reload) + persist a ledger row per card
 * + create the Square order the paired reader will charge. No money moves here.
 * The client charges the returned order on the reader, then POSTs the completed
 * payment to /terminal-finalize. See service/terminal-purchase.ts.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = TerminalPrepareSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Missing or invalid purchase details.");
    }
    const result = await prepareTerminalPurchase(parsed.data);
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
