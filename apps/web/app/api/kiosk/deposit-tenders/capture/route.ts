import { NextRequest, NextResponse } from "next/server";
import { captureSplit } from "~/features/kiosk/service/split-tenders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Atomic capture of the split-tender set: verifies every payment (gift-card
 * auth + reader tap) is capturable and the amounts sum EXACTLY to the
 * checkout total, then PayOrder settles the whole set (order state
 * authoritative — probe #1). Idempotent: a replay after success returns
 * alreadyCaptured. The client then runs reserve-all with
 * externalPayment.paymentIds = the returned set.
 */
export async function POST(req: NextRequest) {
  let body: { seed?: string; splitToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.seed || !body.splitToken) {
    return NextResponse.json({ error: "seed and splitToken required" }, { status: 400 });
  }

  const result = await captureSplit({ seed: body.seed, splitToken: body.splitToken });
  if (!result.ok) {
    console.warn(
      `[kiosk-split] capture failed seed=${body.seed} error=${result.error}${"detail" in result && result.detail ? ` detail=${result.detail}` : ""}`,
    );
    const status =
      result.error === "no-session" ? 403 : result.error === "sum-mismatch" ? 409 : 502;
    return NextResponse.json(
      {
        error:
          result.error === "sum-mismatch"
            ? "The payments don't cover the total yet — finish the card payment first."
            : "We couldn't finish the payment — try again or see the front desk.",
      },
      { status },
    );
  }
  console.log(
    `[kiosk-split] captured seed=${body.seed} payments=${result.paymentIds.join(",")}${result.alreadyCaptured ? " (replay)" : ""}`,
  );
  return NextResponse.json(result);
}
