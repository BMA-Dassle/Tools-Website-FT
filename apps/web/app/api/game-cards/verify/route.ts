import type { NextRequest } from "next/server";
import { VerifyCardSchema } from "~/features/game-cards/schemas";
import { verifyCard } from "~/features/game-cards/service/verify";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = VerifyCardSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Enter a valid card number.");
    }
    const result = await verifyCard(parsed.data);
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
