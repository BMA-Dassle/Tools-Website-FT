import type { NextRequest } from "next/server";
import { getCenter, macForCenter, isOnsiteEnabled } from "~/config/intercard-centers";
import { probeOnsite } from "~/features/game-cards/data/intercard-onsite";
import { jsonOk } from "~/features/game-cards/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Onsite card-system liveness: GET ?locationCode=12 → { status, detail? }.
 *
 * This MUST live server-side: the probe needs the Intercard client token, which
 * is a credential (like the MAC) and must never reach the browser. The kiosk
 * calls this for its status chip instead of dialing the old on-prem bridge on
 * 127.0.0.1 — that bridge answers for a DIFFERENT path (the EIS socket, which
 * cannot consolidate or clear), so its health says nothing about whether the
 * onsite proxy is actually serving this center.
 *
 * Statuses (from probeOnsite, which never throws):
 *   onsite      — the site's relay answered; real-time path is live
 *   offline     — licensed, but no relay connected / it timed out
 *   unlicensed  — licence mismatch: a CONFIG bug, not a site outage
 *   error       — transport/unknown
 *   disabled    — the kill switch is on, so we are deliberately on cloud
 */
export async function GET(req: NextRequest) {
  const code = Number(new URL(req.url).searchParams.get("locationCode") || "");
  if (!Number.isInteger(code) || !getCenter(code)) {
    return jsonOk({ status: "error", detail: "invalid locationCode" });
  }
  if (!isOnsiteEnabled()) {
    return jsonOk({ status: "disabled", detail: "onsite kill switch is set" });
  }
  if (!macForCenter(code)) {
    return jsonOk({ status: "unlicensed", detail: `Intercard MAC is not set (location ${code})` });
  }
  const res = await probeOnsite(code);
  return jsonOk(res);
}
