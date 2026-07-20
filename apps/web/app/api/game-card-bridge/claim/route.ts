/**
 * Outbound poll target for the on-prem game-card-bridge: atomically claim
 * queued web-reload credit jobs for ONE center (FOR UPDATE SKIP LOCKED — safe
 * with multiple bridge PCs polling the same center). Trust gate: the
 * `x-gc-bridge-secret` header must equal GAME_CARD_BRIDGE_SECRET, same shared-
 * secret pattern as the kart/vt3 bridge webhooks.
 */
import { NextResponse, type NextRequest } from "next/server";
import { BridgeClaimSchema } from "~/features/game-cards/schemas";
import { claimJobs } from "~/features/game-cards/service/bridge-queue";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET = process.env.GAME_CARD_BRIDGE_SECRET || "";

export async function POST(req: NextRequest) {
  if (!SECRET) {
    console.error("[gc-bridge] GAME_CARD_BRIDGE_SECRET not configured");
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }
  // Secret rides the header OR the body (`secret`): center firewalls doing
  // SSL inspection have been seen stripping custom request headers; a JSON
  // body field survives their sanitizers. Zod strips the extra key.
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const provided =
    req.headers.get("x-gc-bridge-secret") ??
    (typeof body?.secret === "string" ? body.secret : null);
  if (provided !== SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const parsed = BridgeClaimSchema.safeParse(body);
    if (!parsed.success) {
      throw new GameCardHttpError(400, "INVALID_INPUT", "Bad claim payload.");
    }
    const { jobs, leaseMs } = await claimJobs(parsed.data);
    return jsonOk({ ok: true, jobs, leaseMs });
  } catch (err) {
    return toErrorResponse(err);
  }
}
