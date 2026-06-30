import { NextRequest, NextResponse } from "next/server";

import {
  addOnQuoteRequestSchema,
  buildAddOnQuote,
  checkAddOnCapacity,
  loadAddOnContext,
  serverHeatFreeSpots,
  AddOnContextError,
} from "~/features/combo-addon";
import { comboAddonEnabled, getComboSpecial } from "~/features/combos";

/**
 * POST /api/book/add-on/quote — price + capacity for adding N guests to a combo.
 * Read-only (no charge). Gated by NEXT_PUBLIC_COMBO_ADDON_ENABLED via the
 * combo's addon policy (loadAddOnContext throws ADDON_DISABLED when off).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = addOnQuoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Bad request" },
      { status: 400 },
    );
  }
  const { billId, guestCount } = parsed.data;

  try {
    const ctx = await loadAddOnContext(billId);
    const combo = getComboSpecial(ctx.comboSpecialId);
    if (!combo || !comboAddonEnabled(combo)) {
      return NextResponse.json(
        { error: "Guests can't be added to this booking." },
        { status: 403 },
      );
    }

    const origin = new URL(req.url).origin;
    const deps = serverHeatFreeSpots(origin, ctx.clientKey);
    const capacity = await checkAddOnCapacity(combo, ctx, guestCount, deps);
    const quote = buildAddOnQuote(combo, ctx.eventDate, guestCount);

    return NextResponse.json({
      comboName: combo.name,
      eventDate: ctx.eventDate,
      lane: ctx.bowling?.lane ?? null,
      quote,
      capacity,
    });
  } catch (err) {
    if (err instanceof AddOnContextError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error("[add-on/quote] error:", err);
    return NextResponse.json({ error: "Couldn't price that add-on." }, { status: 500 });
  }
}
