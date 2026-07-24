import type { NextRequest } from "next/server";
import { ConsolidateSchema } from "~/features/game-cards/schemas";
import { consolidate } from "~/features/game-cards/service/consolidate";
import { getCenter, macForCenter } from "~/config/intercard-centers";
import { GameCardHttpError, jsonOk, toErrorResponse } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Availability probe: GET ?locationCode=13 → { available, reason? }. The kiosk
 * checks this BEFORE showing the Combine button — an unconfigured backend must
 * hide the feature, never dead-end a guest mid-flow. The combine rides the same
 * cloud SOAP host + MAC as the (working) token loads, so MAC presence is the
 * whole check.
 */
export async function GET(req: NextRequest) {
  const code = Number(new URL(req.url).searchParams.get("locationCode") || "");
  if (!Number.isInteger(code) || !getCenter(code)) {
    return jsonOk({ available: false, reason: "invalid locationCode" });
  }
  if (!macForCenter(code)) {
    return jsonOk({ available: false, reason: `Intercard MAC is not set (location ${code})` });
  }
  return jsonOk({ available: true });
}

/**
 * Card consolidation (CLOUD ONLY). Moves ALL value from one source card onto a
 * target card via the documented ConsolidateCards op (Enhanced 3PI), sent
 * server-side over TCP to the cloud Transaction Server. Money-safety (atomic
 * all-or-nothing; never bin an unconfirmed source) lives in the service. The
 * kiosk calls this once per source and bins the source only when `ok` is true.
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
