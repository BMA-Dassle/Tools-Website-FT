import { NextRequest, NextResponse } from "next/server";
import {
  createTerminalCheckout,
  getTerminalCheckout,
  dismissTerminalCheckout,
} from "~/features/kiosk/service/square-terminal";

/**
 * Card-present checkout on a paired Square reader (kiosk cardInputMethod
 * "reader"/"swipe"). The kiosk client:
 *   POST { deviceId, amountCents, referenceId } → { checkoutId }
 *   GET  ?id=…  → { status, paymentIds }   (client polls until COMPLETED/CANCELED)
 *   DELETE ?id=… → cancel
 *
 * No auth beyond being an in-center device: this only starts a charge on a
 * physically-present, pre-paired reader for an amount the caller supplies —
 * the sensitive card data never touches us (it's on the Terminal). Completion
 * is polled (Square Terminal API has no synchronous result), matching the
 * Mercury pattern; the kiosk browser is long-lived so it owns the poll loop.
 */

export async function POST(req: NextRequest) {
  let body: { deviceId?: string; amountCents?: number; referenceId?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.deviceId || !body.amountCents || body.amountCents <= 0 || !body.referenceId) {
    return NextResponse.json(
      { error: "deviceId, positive amountCents, and referenceId required" },
      { status: 400 },
    );
  }
  try {
    const result = await createTerminalCheckout({
      deviceId: body.deviceId,
      amountCents: Math.round(body.amountCents),
      referenceId: body.referenceId,
      note: body.note,
    });
    if (!result) {
      return NextResponse.json({ error: "Square not configured" }, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "checkout error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const result = await getTerminalCheckout(id);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "poll error" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const ok = await dismissTerminalCheckout(id);
  return NextResponse.json({ ok });
}
