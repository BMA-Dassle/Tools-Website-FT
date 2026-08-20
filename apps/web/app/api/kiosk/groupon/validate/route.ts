import { NextRequest, NextResponse } from "next/server";
import { looksLikeGrouponCode } from "~/features/groupon/codes";
import { validateGrouponForKiosk } from "~/features/groupon/service/kiosk-validate.server";
import type { ValidatedItem } from "~/features/game-cards/vouchers/validated-items";
import type { GrouponRefusal } from "~/features/groupon/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/kiosk/groupon/validate — what is still on this Groupon voucher?
 *
 * NON-DESTRUCTIVE, and that is the whole design. It never claims a leg and
 * never redeems at Groupon: the PATCH happens only after an item is actually
 * delivered (see `redeemAfterDelivery`), so a jammed dispenser can never eat a
 * guest's voucher. Safe to call on every scan, including a speculative one.
 *
 * SPECULATIVE IS THE NORMAL CASE. Groupon's short code is 8 alphanumerics,
 * indistinguishable from an 8-character promo code and — when all digits, as
 * the real production code `89895632` is — from a game-card barcode. So the
 * kiosk tries its primary path first and calls this only as a FALLBACK. Most
 * calls here are expected to answer "unknown", cheaply.
 *
 * Security posture: kiosk-route posture, same as the other endpoints in this
 * folder — no device auth. Nothing here returns PII; the response describes
 * what a voucher grants, gated on holding the voucher. The shape is left as a
 * strict pre-filter so a random promo code does not become a Groupon API call.
 */

export interface GrouponValidateResponse {
  ok: boolean;
  label?: string;
  items?: ValidatedItem[];
  spentItems?: { index: number; label: string }[];
  firstScan?: boolean;
  reason?: GrouponRefusal | "bad_format";
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json<GrouponValidateResponse>(
      { ok: false, reason: "bad_format" },
      { status: 400 },
    );
  }

  const code = typeof body.code === "string" ? body.code : "";
  // Shape gate BEFORE any network call: the fallback fires on codes that are
  // usually not Groupon at all, and a promo typo must not reach the vendor.
  if (!code || !looksLikeGrouponCode(code)) {
    return NextResponse.json<GrouponValidateResponse>({ ok: false, reason: "bad_format" });
  }

  try {
    const res = await validateGrouponForKiosk(code);
    if (!res.ok) {
      return NextResponse.json<GrouponValidateResponse>({ ok: false, reason: res.reason });
    }
    return NextResponse.json<GrouponValidateResponse>({
      ok: true,
      label: res.label,
      items: res.items,
      spentItems: res.spentItems,
      firstScan: res.firstScan,
    });
  } catch (err) {
    // Never let an upstream wobble read as "no such voucher" — that would tell
    // a guest holding a live voucher that it does not exist.
    console.error("[kiosk/groupon/validate]", err);
    return NextResponse.json<GrouponValidateResponse>(
      { ok: false, reason: "unavailable" },
      { status: 200 },
    );
  }
}
