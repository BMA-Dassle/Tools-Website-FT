import { NextRequest, NextResponse } from "next/server";
import { kioskSplitTenderEnabled, kioskTerminalEnabled } from "~/features/kiosk/flags";
import {
  addGiftCardTender,
  getSplitStatus,
  removeGiftCardTender,
  type SplitError,
} from "~/features/kiosk/service/split-tenders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk split-tender ledger routes (v1: ONE gift card + ONE tap):
 *   POST   { seed, lookupToken } → authorize the gift card → { tender, remainingCents }
 *   DELETE { seed }              → void the gift-card auth (guest changed mind)
 *   GET    ?seed=                → resume state after a refresh/crash
 * Capture and abandon live at ./capture and ./abandon.
 *
 * Same trust model as terminal-checkout: an in-center device operating on a
 * session anchor only IT knows the seed for; every money value is
 * server-derived (the anchor + Square), never the client's claim.
 */

function errStatus(error: SplitError): number {
  switch (error) {
    case "not-enabled":
      return 404;
    case "no-session":
    case "already-captured":
      return 403;
    case "token-invalid":
      return 400;
    case "gc-limit":
    case "zero-balance":
    case "card-unusable":
    case "sum-mismatch":
    case "nothing-to-capture":
      return 422;
    default:
      return 502;
  }
}

const FRIENDLY: Partial<Record<SplitError, string>> = {
  "no-session": "Session not found — start checkout again.",
  "already-captured": "This payment is already complete.",
  "token-invalid": "That gift card lookup expired — scan it again.",
  "gc-limit": "Only one gift card per checkout for now.",
  "card-unusable": "We couldn't use that gift card.",
  "zero-balance": "This gift card has no remaining balance.",
  "sum-mismatch": "The payment amounts don't add up — remove and re-add the gift card.",
  "nothing-to-capture": "No gift card is applied.",
};

function gate(): NextResponse | null {
  if (!kioskSplitTenderEnabled() || !kioskTerminalEnabled()) {
    return NextResponse.json({ error: "Not enabled" }, { status: 404 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const gated = gate();
  if (gated) return gated;
  let body: { seed?: string; splitToken?: string; lookupToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.seed || !body.splitToken || !body.lookupToken) {
    return NextResponse.json(
      { error: "seed, splitToken, and lookupToken required" },
      { status: 400 },
    );
  }
  const result = await addGiftCardTender({
    seed: body.seed,
    splitToken: body.splitToken,
    lookupToken: body.lookupToken,
  });
  if (!result.ok) {
    console.warn(
      `[kiosk-split] add tender failed seed=${body.seed} error=${result.error}${"detail" in result && result.detail ? ` detail=${result.detail}` : ""}`,
    );
    return NextResponse.json(
      { error: FRIENDLY[result.error] ?? "Gift card could not be applied." },
      { status: errStatus(result.error) },
    );
  }
  console.log(
    `[kiosk-split] gift card applied seed=${body.seed} last4=${result.tender.ganLast4} amount=${result.tender.amountCents} remaining=${result.remainingCents}`,
  );
  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
  const gated = gate();
  if (gated) return gated;
  const url = new URL(req.url);
  const seed = url.searchParams.get("seed") ?? "";
  const splitToken = url.searchParams.get("splitToken") ?? "";
  if (!seed || !splitToken) {
    return NextResponse.json({ error: "Missing seed/splitToken" }, { status: 400 });
  }
  const result = await removeGiftCardTender({ seed, splitToken });
  if (!result.ok) {
    return NextResponse.json(
      { error: FRIENDLY[result.error] ?? "Could not remove the gift card." },
      { status: errStatus(result.error) },
    );
  }
  console.log(`[kiosk-split] gift card removed seed=${seed} remaining=${result.remainingCents}`);
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  const gated = gate();
  if (gated) return gated;
  const url = new URL(req.url);
  const seed = url.searchParams.get("seed") ?? "";
  const splitToken = url.searchParams.get("splitToken") ?? "";
  if (!seed || !splitToken) {
    return NextResponse.json({ error: "Missing seed/splitToken" }, { status: 400 });
  }
  const result = await getSplitStatus({ seed, splitToken });
  if (!result.ok) {
    return NextResponse.json(
      { error: FRIENDLY[result.error] ?? "Status unavailable." },
      { status: errStatus(result.error) },
    );
  }
  return NextResponse.json(result);
}
