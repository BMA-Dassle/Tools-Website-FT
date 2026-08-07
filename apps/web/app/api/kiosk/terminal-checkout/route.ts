import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import {
  createTerminalCheckout,
  getTerminalCheckout,
  dismissTerminalCheckout,
} from "~/features/kiosk/service/square-terminal";
import {
  readTerminalAnchor,
  stampTerminalPaymentOnAnchor,
  stampVerifiedTerminalTender,
  updateTerminalAnchor,
} from "~/features/booking/service/unified-reserve";
import { getSquarePayment } from "~/features/booking/service/deposit";
import {
  captureSplit,
  getSplitStatus,
  harvestAndDismissPending,
  splitRemainingCents,
  verifiedCancel,
} from "~/features/kiosk/service/split-tenders";
import { MAX_TOTAL_TENDERS } from "~/features/booking/service/tenders";
import { kioskAmbientCheckoutEnabled } from "~/features/kiosk/flags";
import { touchSplitAttempt, upsertSplitAttempt } from "~/features/kiosk/data/split-tenders-db";

/**
 * Card-present checkout on a paired Square reader (kiosk cardInputMethod
 * "reader"/"swipe"). Three POST body shapes, newest first:
 *
 *   AMBIENT (2026-08, the one rail): { deviceId, referenceId, seed, splitToken }
 *     — NO client amount. The server arms the anchor's remainder, auth-only +
 *     accept_partial_authorization (kill switch KIOSK_AMBIENT_CHECKOUT
 *     reverts to capture-on-tap). GET drives the loop: it verifies + stamps
 *     every payment, and inline-captures (PayOrder) when the set covers the
 *     total. A swiped gift card that can't cover the amount partially
 *     approves; the client boards it and re-arms for the remainder.
 *
 *   LEGACY SPLIT (amber-button flow, retired with PR-6): + splitAmountCents —
 *     cross-checked against the server remainder (409 = re-sync).
 *
 *   LEGACY FULL-AMOUNT (pre-ambient bundles + kill-switch-off reader):
 *     { deviceId, amountCents, referenceId, orderId, idempotencyKey } —
 *     capture-on-tap, verbatim pre-ambient behavior.
 *
 * No auth beyond being an in-center device — the sensitive card data never
 * touches us (it's on the Terminal). Completion is polled (no webhooks),
 * matching the Mercury pattern; the kiosk browser owns the poll loop.
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
    /** LEGACY SPLIT: arm the reader for the REMAINDER after the gift card,
     *  auth-only; the amount is validated against the anchor server-side. */
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

  // ── AMBIENT arm: seed + splitToken and NO amount of any kind. The server
  //    owns the amount entirely — a client claim would 409-loop the moment a
  //    partial approval moves the remainder server-side. ────────────────────
  if (body.seed && body.splitToken && body.splitAmountCents == null && body.amountCents == null) {
    return armAmbient({
      deviceId: body.deviceId,
      referenceId: body.referenceId,
      seed: body.seed,
      splitToken: body.splitToken,
      note: body.note,
    });
  }

  // ── LEGACY SPLIT fork: server-authoritative amount + auth-only + salted key.
  //    When absent, the legacy full-amount autocomplete path below runs
  //    verbatim. Both retire with PR-6 once the fleet is on the new bundle. ──
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
    let idemKey = body.idempotencyKey;
    let result = await createTerminalCheckout({
      deviceId: body.deviceId,
      amountCents: Math.round(body.amountCents),
      referenceId: body.referenceId,
      note: body.note,
      orderId: body.orderId,
      idempotencyKey: idemKey,
    });
    // Dead-replay escape hatch: with a deterministic key, a retry AFTER the
    // first arm was canceled (guest let the reader time out / tapped Cancel)
    // replays the original — now CANCELED — checkout from Square forever, so
    // the reader never re-arms and the kiosk loops back to Review & Pay
    // (kiosk 5, 2026-07-31). A CANCELED checkout captured nothing, so re-arm
    // under a key chained off the dead checkout's id. The chain stays
    // deterministic: concurrent/repeated retries converge on the same live
    // checkout instead of arming the reader twice.
    for (let hop = 0; result && idemKey && result.status === "CANCELED" && hop < 5; hop++) {
      idemKey = `${body.idempotencyKey}-r:${result.checkoutId}`;
      console.log(
        `[kiosk-terminal] CHECKOUT replay was CANCELED (${result.checkoutId}) — re-arming with idem=${idemKey}`,
      );
      result = await createTerminalCheckout({
        deviceId: body.deviceId,
        amountCents: Math.round(body.amountCents),
        referenceId: body.referenceId,
        note: body.note,
        orderId: body.orderId,
        idempotencyKey: idemKey,
      });
    }
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

/**
 * AMBIENT arm: harvest-then-dismiss any prior checkout, compute the remainder
 * over every authorized tender, persist the attempt row (the sweep's work
 * list), then arm the reader for exactly the remainder — auth-only + partial
 * authorization when the kill switch is on, capture-on-tap when it's off.
 */
async function armAmbient(args: {
  deviceId: string;
  referenceId: string;
  seed: string;
  splitToken: string;
  note?: string;
}) {
  const ambient = kioskAmbientCheckoutEnabled();
  let anchor = await readTerminalAnchor(args.seed);
  if (!anchor?.splitToken || anchor.splitToken !== args.splitToken) {
    return NextResponse.json({ error: "No payment session found" }, { status: 403 });
  }
  if (anchor.capturedAt) {
    return NextResponse.json(
      { error: "Payment already complete", captured: true },
      { status: 409 },
    );
  }
  // Retire the prior arm WITHOUT losing a tap that raced in (harvest stamps
  // verified tenders; the dismiss frees the reader).
  anchor = await harvestAndDismissPending(args.seed, anchor);
  const remaining = splitRemainingCents(anchor);
  if (remaining <= 0 && (anchor.tenders ?? []).some((t) => t.status === "authorized")) {
    // A harvested tap already covers the total — capture instead of re-arming.
    const cap = await captureSplit({ seed: args.seed, splitToken: args.splitToken });
    if (cap.ok) {
      return NextResponse.json({
        status: "COMPLETED",
        captured: true,
        paymentIds: cap.paymentIds,
        primaryPaymentId: cap.primaryPaymentId,
        remainingCents: 0,
      });
    }
    return NextResponse.json({ error: "Payment needs the front desk" }, { status: 502 });
  }
  const authorizedCount = (anchor.tenders ?? []).filter((t) => t.status === "authorized").length;
  if (authorizedCount >= MAX_TOTAL_TENDERS) {
    return NextResponse.json({ error: "tender-limit", remainingCents: remaining }, { status: 409 });
  }
  // Persist-first at EVERY arm: this row is how the sweep enumerates open
  // sessions — a card-only walk-away is invisible without it.
  await upsertSplitAttempt({
    seed: args.seed,
    baseKey: anchor.baseKey,
    depositOrderId: anchor.depositOrderId,
    locationId: anchor.locationId,
    totalCents: anchor.totalCents ?? anchor.depositCents + (anchor.gameCards?.totalCents ?? 0),
  });
  // Fresh arm number FIRST (a canceled/timed-out checkout burns its key).
  const armed = await updateTerminalAnchor(args.seed, (a) => ({
    ...a,
    termArm: (a.termArm ?? 0) + 1,
  }));
  if (!armed) {
    return NextResponse.json({ error: "No payment session found" }, { status: 403 });
  }
  const attempt = armed.attempt ?? 0;
  try {
    const result = await createTerminalCheckout({
      deviceId: args.deviceId,
      amountCents: remaining,
      referenceId: args.referenceId,
      note: args.note ?? "Kiosk checkout",
      orderId: armed.depositOrderId,
      idempotencyKey: `term-${armed.baseKey}-a${attempt}-r${armed.termArm ?? 1}`,
      autocomplete: !ambient,
      acceptPartialAuthorization: ambient,
    });
    if (!result) {
      return NextResponse.json({ error: "Square not configured" }, { status: 500 });
    }
    if (result.alreadyPaid) {
      // The order completed on a prior attempt — surface the captured shape.
      return NextResponse.json({
        status: "COMPLETED",
        captured: true,
        paymentIds: result.paymentIds ?? [],
        primaryPaymentId: result.paymentIds?.[0],
        remainingCents: 0,
        checkoutId: result.checkoutId,
      });
    }
    await updateTerminalAnchor(args.seed, (a) => ({
      ...a,
      pendingCheckout: { id: result.checkoutId, attempt, termArm: armed.termArm ?? 1 },
      // Written alongside for one release — pre-ambient readers dismiss it.
      pendingCheckoutId: result.checkoutId,
    }));
    console.log(
      `[kiosk-ambient] reader armed seed=${args.seed} amount=${remaining} checkout=${result.checkoutId} arm=${armed.termArm} partialAuth=${ambient}`,
    );
    return NextResponse.json({
      checkoutId: result.checkoutId,
      status: result.status,
      remainingCents: remaining,
    });
  } catch (err) {
    console.error("[kiosk-ambient] ARM error:", err);
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
  const splitToken = url.searchParams.get("splitToken") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const result = await getTerminalCheckout(id);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // ── AMBIENT poll driver (splitToken present): verify + stamp EVERY
    //    payment, then capture inline when the set covers the total. ────────
    if (seed && splitToken) {
      return pollAmbient(id, seed, splitToken, result);
    }

    // ── Legacy poll (pre-ambient bundles + kill-switch-off reader): stamp the
    //    first payment id as a recovery pointer, return the raw shape. ───────
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

/** Throttled liveness touch: the sweep's staleness clock must track a live
 *  guest without a Neon UPDATE on every 1.5s poll. */
async function touchThrottled(seed: string, baseKey: string): Promise<void> {
  try {
    const ok = await redis.set(`kiosk:split:touch:${seed}`, "1", "EX", 15, "NX");
    if (ok === "OK") await touchSplitAttempt(baseKey);
  } catch {
    /* liveness only — the 45-minute staleness window absorbs a missed touch */
  }
}

async function pollAmbient(
  checkoutId: string,
  seed: string,
  splitToken: string,
  checkout: { status: string; paymentIds?: string[] },
) {
  const anchor = await readTerminalAnchor(seed);
  if (!anchor?.splitToken || anchor.splitToken !== splitToken) {
    return NextResponse.json({ error: "No payment session found" }, { status: 403 });
  }

  if (checkout.status !== "COMPLETED" && checkout.status !== "CANCELED") {
    await touchThrottled(seed, anchor.baseKey);
    return NextResponse.json({ status: checkout.status });
  }
  if (checkout.status === "CANCELED") {
    return NextResponse.json({ status: "CANCELED" });
  }

  // Stray-arm guard: a checkout armed BEFORE an unwind (attempt has moved on)
  // must not fund the session — the guest already removed/abandoned what that
  // amount was based on. Void whatever it produced, report CANCELED.
  const armRecord = anchor.pendingCheckout;
  if (armRecord?.id === checkoutId && armRecord.attempt !== (anchor.attempt ?? 0)) {
    for (const pid of checkout.paymentIds ?? []) {
      await verifiedCancel(anchor.baseKey, pid);
    }
    await updateTerminalAnchor(seed, (a) =>
      a.pendingCheckout?.id === checkoutId
        ? { ...a, pendingCheckout: undefined, pendingCheckoutId: undefined }
        : a,
    );
    return NextResponse.json({ status: "CANCELED" });
  }

  // Verify + stamp EVERY payment on the checkout (a partial-auth checkout
  // reports COMPLETED with its short-approved payment attached).
  let lastTender: {
    paymentId: string;
    amountCents: number;
    sourceType?: string;
    cardBrand?: string;
    last4?: string;
  } | null = null;
  for (const pid of checkout.paymentIds ?? []) {
    const pay = await getSquarePayment(pid);
    if (!pay || (pay.status !== "APPROVED" && pay.status !== "COMPLETED")) {
      // Square read lag — keep polling; the sweep is the backstop.
      return NextResponse.json({ status: "IN_PROGRESS", verifyPending: true });
    }
    if (pay.orderId && pay.orderId !== anchor.depositOrderId) {
      console.error(
        `[kiosk-ambient] payment ${pid} paid order ${pay.orderId}, expected ${anchor.depositOrderId} — not stamping`,
      );
      continue;
    }
    await stampVerifiedTerminalTender(seed, {
      paymentId: pid,
      amountCents: pay.effectiveCents,
      sourceType: pay.sourceType,
      cardBrand: pay.cardBrand,
      last4: pay.last4,
      checkoutId,
    });
    lastTender = {
      paymentId: pid,
      amountCents: pay.effectiveCents,
      sourceType: pay.sourceType,
      cardBrand: pay.cardBrand,
      last4: pay.last4,
    };
  }

  const status = await getSplitStatus({ seed, splitToken });
  if (!status.ok) {
    return NextResponse.json({ error: "No payment session found" }, { status: 403 });
  }
  const { remainingCents, tenders } = status.status;

  if (remainingCents === 0) {
    const cap = await captureSplit({ seed, splitToken });
    if (cap.ok) {
      console.log(
        `[kiosk-ambient] captured seed=${seed} payments=${cap.paymentIds.join(",")}${cap.alreadyCaptured ? " (replay)" : ""}`,
      );
      return NextResponse.json({
        status: "COMPLETED",
        captured: true,
        paymentIds: cap.paymentIds,
        primaryPaymentId: cap.primaryPaymentId,
        remainingCents: 0,
        tenders,
      });
    }
    // busy = a concurrent capture holds the lock — the next poll converges.
    if (cap.error === "busy") {
      return NextResponse.json({ status: "IN_PROGRESS", verifyPending: true });
    }
    console.error(`[kiosk-ambient] capture failed seed=${seed} error=${cap.error}`);
    return NextResponse.json(
      { error: "We couldn't finish the payment — try again or see the front desk." },
      { status: 502 },
    );
  }

  // Partial approval: the board shows the applied tender; the client re-arms.
  return NextResponse.json({
    status: "COMPLETED",
    captured: false,
    remainingCents,
    tender: lastTender,
    tenders,
  });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const ok = await dismissTerminalCheckout(id);
  return NextResponse.json({ ok });
}
