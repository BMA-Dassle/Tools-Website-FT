/**
 * Ack target for the on-prem game-card-bridge: report what the local EIS
 * credit actually did for one claimed job (ok / declined / no_attempt /
 * unknown). Guarded transitions in the data layer make acks idempotent —
 * `applied:false` means the row already moved on, and the bridge must stop
 * retrying (any 2xx is final). Same trust gate as /claim.
 */
import { NextResponse, type NextRequest } from "next/server";
import { BridgeAckSchema } from "~/features/game-cards/schemas";
import { ackJob } from "~/features/game-cards/service/bridge-queue";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET = process.env.GAME_CARD_BRIDGE_SECRET || "";

export async function POST(req: NextRequest) {
  if (!SECRET) {
    console.error("[gc-bridge] GAME_CARD_BRIDGE_SECRET not configured");
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }
  if (req.headers.get("x-gc-bridge-secret") !== SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => null);
    const parsed = BridgeAckSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Bad ack payload.");
    }
    const { applied } = await ackJob(parsed.data);
    return jsonOk({ ok: true, applied });
  } catch (err) {
    return toErrorResponse(err);
  }
}
