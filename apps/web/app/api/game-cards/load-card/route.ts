import type { NextRequest } from "next/server";
import { LoadCardSchema } from "~/features/game-cards/schemas";
import { loadCard } from "~/features/game-cards/service/load-card";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Buy flow, phase 2: credit tokens onto a just-dispensed new card. The upfront
 * charge already happened (POST /purchase kind:"new_card"); this is called once
 * per card as the kiosk dispenses + reads it, before presenting it to the guest.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = LoadCardSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Missing or invalid load details.");
    }
    const result = await loadCard(parsed.data);
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
