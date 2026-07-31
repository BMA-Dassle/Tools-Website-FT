import { NextRequest, NextResponse } from "next/server";
import {
  createTerminalCheckout,
  getTerminalCheckout,
  dismissTerminalCheckout,
} from "~/features/kiosk/service/square-terminal";
import {
  readTerminalAnchor,
  stampTerminalPaymentOnAnchor,
  updateTerminalAnchor,
} from "~/features/booking/service/unified-reserve";
import { splitRemainingCents } from "~/features/kiosk/service/split-tenders";

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
  let body: {
    deviceId?: string;
    amountCents?: number;
    referenceId?: string;
    note?: string;
    /** Pay OUR prepared deposit order (direct-Terminal money path). */
    orderId?: string;
    /** Deterministic key so a retry replays the SAME checkout (reader armed once). */
    idempotencyKey?: string;
    /** SPLIT (kiosk v1, flag-gated): arm the reader for the REMAINDER after the
     *  gift card, auth-only (autocomplete:false — captured later by PayOrder).
     *  Requires seed + the prepare-minted splitToken; the amount is validated
     *  against the anchor server-side. */
    splitAmountCents?: number;
    seed?: string;
    splitToken?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.deviceId || !body.referenceId) {
    return NextResponse.json({ error: "deviceId and referenceId required" }, { status: 400 });
  }

  // ── SPLIT fork: server-authoritative amount + auth-only + salted key. When
  //    absent, the legacy full-amount autocomplete path below runs verbatim. ──
  if (body.splitAmountCents != null) {
    if (!body.seed || !body.splitToken) {
      return NextResponse.json(
        { error: "seed and splitToken required for a split checkout" },
        { status: 400 },
      );
    }
    const anchor = await readTerminalAnchor(body.seed);
    // The seed alone is guessable (bill id) — the prepare-minted splitToken is
    // the session secret, same gate as the deposit-tenders routes.
    if (!anchor?.split || !anchor.splitToken || anchor.splitToken !== body.splitToken) {
      return NextResponse.json({ error: "No split session found" }, { status: 403 });
    }
    if (anchor.capturedAt) {
      return NextResponse.json({ error: "Payment already complete" }, { status: 409 });
    }
    const remaining = splitRemainingCents(anchor);
    if (Math.round(body.splitAmountCents) !== remaining || remaining <= 0) {
      // Never arm the reader for a client-claimed amount — 409 tells the client
      // to re-sync (a tender changed under it).
      return NextResponse.json(
        { error: `Amount out of date — ${remaining}¢ remains`, remainingCents: remaining },
        { status: 409 },
      );
    }
    // Reserve a fresh arm number FIRST (a canceled/timed-out checkout burns
    // its idempotency key — Square replays the dead one forever), and record
    // the intent so unwind can dismiss whatever ends up armed.
    const armed = await updateTerminalAnchor(body.seed, (a) => ({
      ...a,
      termArm: (a.termArm ?? 0) + 1,
    }));
    if (!armed) {
      return NextResponse.json({ error: "No split session found" }, { status: 403 });
    }
    // A previously-armed checkout (re-arm after timeout/cancel) is dismissed
    // best-effort before the new one goes live — one live checkout at a time.
    if (anchor.pendingCheckoutId) {
      await dismissTerminalCheckout(anchor.pendingCheckoutId).catch(() => {});
    }
    try {
      const result = await createTerminalCheckout({
        deviceId: body.deviceId,
        amountCents: remaining,
        referenceId: body.referenceId,
        note: body.note ?? "Kiosk split tender — card",
        orderId: anchor.depositOrderId,
        // Salted by attempt (unwind counter) AND arm number (re-arm counter).
        idempotencyKey: `term-${anchor.baseKey}-a${anchor.attempt ?? 0}-r${armed.termArm ?? 1}`,
        autocomplete: false, // captured atomically with the GC via PayOrder
      });
      if (!result) {
        return NextResponse.json({ error: "Square not configured" }, { status: 500 });
      }
      await updateTerminalAnchor(body.seed, (a) => ({
        ...a,
        pendingCheckoutId: result.checkoutId,
      }));
      console.log(
        `[kiosk-split] reader armed (auth-only) seed=${body.seed} amount=${remaining} checkout=${result.checkoutId} arm=${armed.termArm}`,
      );
      return NextResponse.json(result);
    } catch (err) {
      console.error("[kiosk-split] CHECKOUT error:", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "checkout error" },
        { status: 500 },
      );
    }
  }

  if (!body.amountCents || body.amountCents <= 0) {
    return NextResponse.json({ error: "positive amountCents required" }, { status: 400 });
  }
  console.log(
    `[kiosk-terminal] CHECKOUT start device=${body.deviceId} amount=${body.amountCents} order=${body.orderId ?? "(none)"} ref=${body.referenceId} idem=${body.idempotencyKey ?? "(random)"}`,
  );
  try {
    const result = await createTerminalCheckout({
      deviceId: body.deviceId,
      amountCents: Math.round(body.amountCents),
      referenceId: body.referenceId,
      note: body.note,
      orderId: body.orderId,
      idempotencyKey: body.idempotencyKey,
    });
    if (!result) {
      console.error("[kiosk-terminal] CHECKOUT createTerminalCheckout returned null (no token?)");
      return NextResponse.json({ error: "Square not configured" }, { status: 500 });
    }
    console.log(
      `[kiosk-terminal] CHECKOUT ok checkoutId=${result.checkoutId} status=${result.status}`,
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error("[kiosk-terminal] CHECKOUT error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "checkout error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const seed = url.searchParams.get("seed") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const result = await getTerminalCheckout(id);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Persist-at-capture: the instant the reader reports COMPLETED, stamp the
    // paymentId onto the prepare anchor so a browser death before reserve still
    // leaves a recoverable pointer for the terminal-orphan reconcile.
    if (seed && result.status === "COMPLETED" && result.paymentIds?.[0]) {
      await stampTerminalPaymentOnAnchor(seed, result.paymentIds[0]).catch(() => {});
    }
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
