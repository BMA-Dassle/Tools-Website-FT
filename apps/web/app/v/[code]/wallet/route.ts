import { NextRequest, NextResponse } from "next/server";
import { isNativeVoucherCode, normalizeVoucherCode } from "~/features/game-cards/vouchers/codes";
import { issueVoucherPass } from "~/features/game-cards/wallet/voucher-pass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Add to Apple / Google Wallet" for a voucher. The tap target in the voucher
 * email, SMS and on `/v/{code}` — never a link straight to PassKit.
 *
 * WHY WE OWN THIS REDIRECT. PassKit can hand out static signed distribution
 * links, which would need no route at all. But a link signed at mint time cannot
 * know the voucher was voided, expired or spent afterwards, and we have already
 * shipped that bug once (deal packs: a voided voucher still worked because cart
 * claims never checked). Owning the hop means the check happens at TAP time,
 * against Neon, every time.
 *
 * THE PASS IS CREATED HERE, NOT AT MINT. PassKit bills single-use passes at
 * issuance, so pre-creating one per minted voucher would bill us for every
 * voucher whose email is never opened. Idempotency is free: `externalId` is our
 * own code and PassKit 409s a duplicate, so a double-tap recovers the same pass.
 *
 * `/v/` is in middleware's `SHARED_TOP_LEVEL_ROUTES` and matches on
 * `startsWith`, so this nested route inherits it — a HeadPinz guest is NOT
 * rewritten into `/hp/v/...` and does not 404. Do not move this route out from
 * under `/v/` without adding it there.
 *
 * Every failure path lands the guest on `/v/{code}`, which already renders the
 * real state per item. A dead end here would be a guest holding a code and no
 * explanation.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code: raw } = await params;
  const code = normalizeVoucherCode(raw ?? "");

  // Shape check before any I/O — the code is a bearer instrument and this route
  // is unauthenticated by design (same posture as the /v/ page itself).
  // RELATIVE redirects keep the guest on whichever brand host they opened, the
  // same property /w/[code] and /s/[code] rely on.
  if (!isNativeVoucherCode(code)) {
    return NextResponse.redirect(new URL(`/v/${encodeURIComponent(raw ?? "")}`, req.url));
  }

  const result = await issueVoucherPass(code);
  if (!result.ok) {
    // `reason` is for support/analytics, not for the guest — the page states the
    // real per-item position, which is more useful than any banner we'd add.
    const url = new URL(`/v/${code}`, req.url);
    url.searchParams.set("wallet", result.refusal);
    return NextResponse.redirect(url);
  }

  // Straight to the platform file so the guest doesn't pay an extra tap on
  // PassKit's own landing page. Desktop keeps the landing page, which offers
  // both and renders a QR.
  const ua = req.headers.get("user-agent") ?? "";
  const target = /iPhone|iPad|iPod|Macintosh/i.test(ua)
    ? result.urls.apple
    : /Android/i.test(ua)
      ? result.urls.google
      : result.urls.landing;

  return NextResponse.redirect(target, {
    // A pass URL is per-voucher and its content changes as legs are redeemed —
    // never let a CDN or the browser cache this hop.
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
