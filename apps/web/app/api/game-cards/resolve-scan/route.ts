import type { NextRequest } from "next/server";
import { ResolveScanSchema } from "~/features/game-cards/schemas";
import { resolveScanToAccount } from "~/features/game-cards/service/resolve-scan";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn a raw scanned QR/barcode value into a card account number, following the
 * Intercard shortlink redirect (`icardinc.net/<code>` → `swflpassport.com/?id=`)
 * when the payload doesn't carry the id directly. The in-app camera scanner
 * calls this when local decoding (cardNumberFromScan) comes up empty.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = ResolveScanSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Nothing to scan.");
    }
    const accountNumber = await resolveScanToAccount(parsed.data.raw);
    if (!accountNumber) {
      throw new GameCardHttpError(422, "UNRESOLVED", "That code isn't a game card.");
    }
    return jsonOk({ accountNumber });
  } catch (err) {
    return toErrorResponse(err);
  }
}
