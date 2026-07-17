import { NextRequest, NextResponse } from "next/server";
import {
  createSaveCardAction,
  getTerminalAction,
  dismissTerminalAction,
} from "~/features/kiosk/service/square-terminal";

/**
 * Card-present card capture on a paired Square reader (kiosk cardInputMethod
 * "reader"/"swipe"). SAVE_CARD vaults the guest's card to a card-on-file id
 * that reserveAll then charges exactly like a saved card — so the existing
 * reserve/deposit/gift-card money rail is reused UNCHANGED.
 *
 *   POST { deviceId, customerId, referenceId } → { actionId }
 *   GET  ?id=…  → { status, cardId }   (client polls until COMPLETED)
 *   DELETE ?id=… → cancel
 *
 * In-center device on a physically-present, pre-paired reader; no card data
 * touches us (it's captured on the Terminal). Completion is polled (Square
 * Terminal Actions API is async), matching the Mercury pattern.
 */

export async function POST(req: NextRequest) {
  let body: { deviceId?: string; customerId?: string; referenceId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.deviceId || !body.customerId || !body.referenceId) {
    return NextResponse.json(
      { error: "deviceId, customerId, and referenceId required" },
      { status: 400 },
    );
  }
  try {
    const result = await createSaveCardAction({
      deviceId: body.deviceId,
      customerId: body.customerId,
      referenceId: body.referenceId,
    });
    if (!result) return NextResponse.json({ error: "Square not configured" }, { status: 500 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "save-card error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const result = await getTerminalAction(id);
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
  return NextResponse.json({ ok: await dismissTerminalAction(id) });
}
