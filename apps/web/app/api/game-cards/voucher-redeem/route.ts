import type { NextRequest } from "next/server";
import { VoucherRedeemSchema } from "~/features/game-cards/schemas";
import {
  claimGameCardVoucher,
  releaseGameCardVoucher,
} from "~/features/game-cards/service/voucher-card";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Game Zone COMP voucher redemption.
 *
 *   claim   → validate the code with BMI, resolve what it grants, take the
 *             GLOBAL single-use claim, and return a $0 ledger row for the kiosk
 *             to dispense + load against.
 *   release → hand an unspent code back (guest walked away / dispenser faulted
 *             before a card moved).
 *
 * A refusal is HTTP 200 + `{ok:false, reason}` — the kiosk phrases every reason
 * for an unattended guest, and a rejected voucher is not a server error. Only
 * malformed requests 400.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = VoucherRedeemSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Missing or invalid voucher details.");
    }

    if (parsed.data.action === "release") {
      await releaseGameCardVoucher({
        code: parsed.data.code,
        txnId: parsed.data.txnId,
        reason: parsed.data.reason ?? "released by kiosk",
      });
      return jsonOk({ released: true });
    }

    const result = await claimGameCardVoucher({
      code: parsed.data.code,
      locationCode: parsed.data.locationCode,
      center: parsed.data.center,
      kioskId: parsed.data.kioskId,
    });
    return jsonOk({ ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
