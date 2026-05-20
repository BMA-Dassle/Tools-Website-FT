"use client";

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";

/**
 * Square gift card capture widget.
 *
 * Wraps `payments.giftCard()` (Square Web Payments SDK). After the
 * user enters a GAN and clicks Apply, this:
 *
 *   1. Tokenizes via Square SDK
 *   2. POSTs the nonce to /api/square/gift-card-balance
 *   3. If balance > 0 and not blocked → calls onApply(nonce, balanceCents, last4)
 *   4. If blocked / inactive / empty → surfaces an inline error
 *
 * Parent owns the "applied" state visually — when a GC is applied,
 * the parent hides this widget and renders a summary line with a
 * "Remove" action that calls back into onClear here (the parent's
 * state changes; this component remounts clean).
 *
 * Single-GC limit: callers should hide / unmount this component when
 * a GC is already applied (v1 supports one GC per checkout).
 */

interface SquareGiftCard {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{
    status: string;
    token?: string;
    errors?: { message: string }[];
  }>;
  destroy: () => void;
}

interface SquarePaymentsLike {
  // Use Promise<unknown> so callers can pass the full Square `payments`
  // instance (typed locally with their own shape) without a type cast.
  // We assert to SquareGiftCard internally below.
  giftCard: (options?: Record<string, unknown>) => Promise<unknown>;
}

export interface GiftCardCaptureHandle {
  /** Imperatively clear the input + reset any errors. Called by parent
   *  when the user removes an applied gift card. */
  reset: () => void;
}

export interface GiftCardApplyResult {
  nonce: string;
  balanceCents: number;
  last4: string;
  gan: string;
}

interface Props {
  /** Live `payments` instance from `window.Square.payments(...)`.
   *  Passed in so this component shares the SDK init done by the
   *  parent PaymentForm / BowlingPaymentStep — no duplicate SDK loads. */
  payments: SquarePaymentsLike | null;
  /** Called after successful tokenize + balance lookup with a usable GC. */
  onApply: (result: GiftCardApplyResult) => void;
  /** Disable input (e.g. while parent is processing a payment). */
  disabled?: boolean;
}

const CONTAINER_ID = "sq-gift-card-container";

const GiftCardCapture = forwardRef<GiftCardCaptureHandle, Props>(function GiftCardCapture(
  { payments, onApply, disabled = false },
  ref,
) {
  const [status, setStatus] = useState<"loading" | "ready" | "tokenizing" | "looking-up" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const gcRef = useRef<SquareGiftCard | null>(null);
  const initRef = useRef(false);

  useImperativeHandle(ref, () => ({
    reset() {
      setErrorMessage(null);
      setStatus("ready");
    },
  }));

  useEffect(() => {
    if (initRef.current) return;
    if (!payments) return;
    initRef.current = true;

    let cancelled = false;
    let instance: SquareGiftCard | null = null;

    (async () => {
      try {
        instance = (await payments.giftCard()) as SquareGiftCard;
        await instance.attach(`#${CONTAINER_ID}`);
        if (cancelled) {
          instance.destroy();
          return;
        }
        gcRef.current = instance;
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          console.warn("[GiftCardCapture] init failed:", err);
          setStatus("error");
          setErrorMessage("Gift card entry could not be loaded.");
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        instance?.destroy();
      } catch {
        /* ignore */
      }
      gcRef.current = null;
    };
  }, [payments]);

  async function handleApply() {
    if (disabled || status === "tokenizing" || status === "looking-up") return;
    if (!gcRef.current) {
      setErrorMessage("Gift card entry not ready. Please refresh and try again.");
      return;
    }
    setErrorMessage(null);
    setStatus("tokenizing");

    const tokResult = await gcRef.current.tokenize();
    if (tokResult.status !== "OK" || !tokResult.token) {
      const msg = tokResult.errors?.[0]?.message || "Could not read gift card. Please re-enter the number.";
      setErrorMessage(msg);
      setStatus("ready");
      return;
    }

    setStatus("looking-up");
    try {
      const res = await fetch("/api/square/gift-card-balance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: tokResult.token }),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || "Could not look up gift card.");
        setStatus("ready");
        return;
      }

      if (data.blocked) {
        setErrorMessage(data.message || "This gift card cannot be used.");
        setStatus("ready");
        return;
      }

      onApply({
        nonce: tokResult.token,
        balanceCents: data.balanceCents,
        last4: data.last4,
        gan: data.gan,
      });
      setStatus("ready");
    } catch {
      setErrorMessage("Could not reach the gift card service. Please try again.");
      setStatus("ready");
    }
  }

  const busy = status === "tokenizing" || status === "looking-up";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-white/60">Gift card</label>
        {busy && (
          <span className="text-xs text-white/40">
            {status === "tokenizing" ? "Reading…" : "Looking up balance…"}
          </span>
        )}
      </div>
      <div
        id={CONTAINER_ID}
        className="rounded-lg border border-white/15 bg-white/5 p-3"
        style={{ minHeight: 56 }}
      />
      {errorMessage && (
        <p className="text-red-400 text-xs" role="alert">
          {errorMessage}
        </p>
      )}
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={disabled || busy || status === "loading" || status === "error"}
        className="w-full py-2 rounded-lg border border-white/20 text-sm text-white/80 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? "Checking…" : "Apply gift card"}
      </button>
    </div>
  );
});

export default GiftCardCapture;
