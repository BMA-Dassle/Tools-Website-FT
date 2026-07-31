import { NextRequest, NextResponse } from "next/server";
import { verifyBillSignature } from "@/lib/booking-confirmation-link";
import { officeProjectIdFromBillId } from "@/lib/bmi-office-ids";
import { waiverLinkForSuppliedUrl } from "@/lib/waiver-link-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/waiver/booking-link — the ORGANIZER short link for a racing booking's
 * confirmation page.
 *
 * A client page must never mint capability codes itself: an open mint endpoint
 * would let anyone mint an organizer code (roster of everyone on the booking +
 * per-person waiver status) for any guessable projectId. This endpoint closes
 * that hole with the SAME proof the rest of the confirmation surface uses — the
 * HMAC bill signature (`verifyBillSignature`) that already authorizes
 * booking-status and self-cancel. Possession of the signed receipt link IS being
 * the booker; the email route makes exactly this judgement when it mints the
 * organizer code for the same person's inbox.
 *
 * Body: { billId, sig, waiverUrl }
 *  - billId + sig — the confirmation page's own signed URL params.
 *  - waiverUrl — the canonical reservation-scoped /waiver link the page built
 *    (buildWaiverUrl with loc+pid). Its pid MUST equal the Office projectId
 *    derived from the authorized billId (billId + 1, string math — the id
 *    exceeds Number.MAX_SAFE_INTEGER, so never Number() it): the signature
 *    authorizes ONE booking, and the pid check binds the mint to that booking
 *    so a valid sig for reservation A can never mint an organizer code for
 *    reservation B.
 *
 * Response: { ok: true, url } — the organizer short link, or (degraded mint —
 * Neon blip) the long sign-only URL, which is exactly what the page falls back
 * to anyway. Errors return ok: false and the page keeps its long CTA; this
 * endpoint can only ever upgrade the experience, never break it.
 */
export async function POST(req: NextRequest) {
  let body: { billId?: unknown; sig?: unknown; waiverUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const billId = typeof body.billId === "string" ? body.billId.trim() : "";
  const sig = typeof body.sig === "string" ? body.sig.trim() : "";
  const waiverUrl = typeof body.waiverUrl === "string" ? body.waiverUrl.trim() : "";
  if (!/^\d+$/.test(billId) || !sig || !waiverUrl) {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  if (!verifyBillSignature(billId, sig)) {
    return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 403 });
  }

  // Bind the mint to the authorized booking. The supplied URL may be relative;
  // the base only exists to satisfy the URL parser.
  let suppliedPid = "";
  try {
    suppliedPid = new URL(waiverUrl, "https://x.invalid").searchParams.get("pid") ?? "";
  } catch {
    /* fall through to the mismatch refusal */
  }
  if (!suppliedPid || suppliedPid !== officeProjectIdFromBillId(billId)) {
    return NextResponse.json({ ok: false, error: "Reservation mismatch" }, { status: 403 });
  }

  const url = await waiverLinkForSuppliedUrl(waiverUrl, "organizer");
  return NextResponse.json(
    { ok: true, url },
    // The body carries an organizer capability — never cacheable, never shared.
    { headers: { "cache-control": "private, no-store" } },
  );
}
