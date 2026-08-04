import { NextRequest, NextResponse } from "next/server";
import { RACER_LOGIN_CODE_RE } from "~/features/kiosk/license/types";

export const dynamic = "force-dynamic";

/**
 * GET /r/{loginCode} — the payload our Apple/Google Wallet racing licence
 * carries in its barcode, and the only racer handle we mint ourselves.
 *
 * WHY THIS EXISTS AS A URL AND NOT A BARE CODE. A BMI login code is ~13
 * alphanumeric characters, which is indistinguishable from a reservation short
 * code and from a promo code — scanned bare at a kiosk it matches
 * `SHORT_CODE_RE`, misses the reservation index and lands the guest on the
 * coupon screen. Wrapping it in a path we own makes it a structural verdict in
 * `entry-scan/classify-entry.ts` with no collision surface, exactly the way
 * `/v/{code}` works for vouchers.
 *
 * WHAT IT DOES IN A BROWSER. The kiosk never fetches this route — it reads the
 * code straight out of the scanned string. This handler is for the other
 * scanner every guest carries: a phone camera pointed at the same barcode opens
 * a URL, and the useful destination is the racing sign-in that already accepts
 * a login code (`/book/race?code=` → `autoCode`). So one barcode is both the
 * kiosk credential and a deep link into booking, for the price of a redirect.
 *
 * NOT AN AUTHENTICATED SURFACE. The redirect target is what enforces the trust
 * model (possession of the code is the identity — the same posture as the
 * kiosk member-QR path); this only validates the shape so a junk scan can't be
 * bounced onward as a search token.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const clean = (code || "").trim();
  if (!RACER_LOGIN_CODE_RE.test(clean)) {
    return NextResponse.redirect(new URL("/book/race", req.url), 302);
  }
  return NextResponse.redirect(
    new URL(`/book/race?code=${encodeURIComponent(clean)}`, req.url),
    302,
  );
}
