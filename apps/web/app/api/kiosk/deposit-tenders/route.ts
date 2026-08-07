import { NextRequest, NextResponse } from "next/server";
import {
  addGiftCardTender,
  getSplitStatus,
  removeGiftCardTender,
  type SplitError,
} from "~/features/kiosk/service/split-tenders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk split-tender ledger routes:
 *   POST   { seed, lookupToken } → authorize the gift card → { tender, remainingCents }
 *   DELETE { seed[, paymentId] } → void ONE gift-card auth (per-row Remove) or,
 *                                  with no paymentId, every hold (legacy v1 board)
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
    case "tender-limit":
    case "tender-not-found":
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
  "gc-limit": "Gift card limit reached for this checkout.",
  "tender-limit": "Payment method limit reached — pay the rest with one card.",
  "tender-not-found": "That gift card is no longer applied.",
  "card-unusable": "We couldn't use that gift card.",
  "zero-balance": "This gift card has no remaining balance.",
  "sum-mismatch": "The payment amounts don't add up — remove and re-add the gift card.",
  "nothing-to-capture": "No gift card is applied.",
};

export async function POST(req: NextRequest) {
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
  const url = new URL(req.url);
  const seed = url.searchParams.get("seed") ?? "";
  const splitToken = url.searchParams.get("splitToken") ?? "";
  // Optional: void only this tender (multi-tender board's per-row Remove).
  const paymentId = url.searchParams.get("paymentId") ?? undefined;
  if (!seed || !splitToken) {
    return NextResponse.json({ error: "Missing seed/splitToken" }, { status: 400 });
  }
  const result = await removeGiftCardTender({ seed, splitToken, paymentId });
  if (!result.ok) {
    return NextResponse.json(
      { error: FRIENDLY[result.error] ?? "Could not remove the gift card." },
      { status: errStatus(result.error) },
    );
  }
  console.log(
    `[kiosk-split] gift card removed seed=${seed} scope=${paymentId ? "single" : "all"} remaining=${result.remainingCents}`,
  );
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
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
