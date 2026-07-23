import type { NextRequest } from "next/server";
import { ConsolidateSchema } from "~/features/game-cards/schemas";
import { consolidate } from "~/features/game-cards/service/consolidate";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Card consolidation (CLOUD ONLY). Moves all value from one source card onto a
 * target card and clears the source, server-side via cloud SOAP. Money-safe
 * ordering (credit-confirm before clear) lives in the service. The kiosk calls
 * this once per source and bins the source only when `ok` is true.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = ConsolidateSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(
        400,
        "INVALID_INPUT",
        "Missing or invalid consolidation details.",
      );
    }
    const result = await consolidate(parsed.data);
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
