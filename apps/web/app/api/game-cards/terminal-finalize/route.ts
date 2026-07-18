import type { NextRequest } from "next/server";
import { TerminalFinalizeSchema } from "~/features/game-cards/schemas";
import { finalizeTerminalPurchase } from "~/features/game-cards/service/terminal-purchase";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * KIOSK direct-Terminal FINALIZE: the reader captured the card against the order
 * PREPARE created. Verify the payment server-side, mark the rows charged (NEVER
 * re-charge), then load (reload) or hand rows back to dispense (new_card).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = TerminalFinalizeSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Missing or invalid payment details.");
    }
    const result = await finalizeTerminalPurchase(parsed.data);
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
