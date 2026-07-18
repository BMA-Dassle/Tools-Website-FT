import type { NextRequest } from "next/server";
import { getSession } from "~/features/account";
import { PurchaseSchema } from "~/features/game-cards/schemas";
import { purchase, chargeNewCardOrder } from "~/features/game-cards/service/purchase";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = PurchaseSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Missing or invalid purchase details.");
    }

    // Optional login: if signed in AND the posted customer belongs to the
    // session, save-card + auto-link run against that customer. Anonymous
    // reload works with no session. Client-supplied customer id is never
    // trusted beyond this membership check.
    const session = await getSession();
    const wanted = parsed.data.squareCustomerId;
    const verifiedCustomerId =
      session && wanted && session.squareCustomerIds.includes(wanted) ? wanted : undefined;

    // BUY (new cards): charge once, hand back rows to dispense + load per card.
    // RELOAD: verify + charge + load all cards in one shot.
    const result =
      parsed.data.kind === "new_card"
        ? await chargeNewCardOrder(parsed.data, { verifiedCustomerId })
        : await purchase(parsed.data, { verifiedCustomerId });
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
