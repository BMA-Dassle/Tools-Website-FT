"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import CardCaptureForm, {
  type CardCaptureHandle,
} from "@/components/square/CardCaptureForm";

/**
 * Shared payment step used by Kids Bowl Free V2 and Open Bowling wizards.
 *
 * Mirrors the pattern used by components/square/PaymentForm.tsx in the
 * karting flow: tokenization is handled INTERNALLY so the card widget is
 * always alive when tokenize() runs. The parent never touches cardRef.
 *
 * Supports Apple Pay and Google Pay via the Square Web Payments SDK.
 *
 * When the user clicks Pay, this component:
 *   1. Calls card.tokenize() (card is still mounted — no risk of INVALID_CARD_DATA)
 *   2. On success, calls onPay(token) — the parent then changes step / calls the API
 *   3. On failure, surfaces tokenizeError inline (no step change needed)
 *
 * The parent should NOT setStep("submitting") before calling onPay; it should
 * do so inside the onPay callback, after tokenize has already completed.
 */

const CORAL = "#fd5b56";

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";
const SDK_URL = "https://web.squarecdn.com/v1/square.js";

const SQUARE_LOCATIONS: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

function resolveLocationId(override?: string): string {
  if (override && SQUARE_LOCATIONS[override]) return SQUARE_LOCATIONS[override];
  if (override && /^[A-Z0-9]{10,}$/.test(override)) return override;
  if (typeof window === "undefined") return SQUARE_LOCATIONS.fasttrax;
  return window.location.hostname.includes("headpinz")
    ? SQUARE_LOCATIONS.headpinz
    : SQUARE_LOCATIONS.fasttrax;
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface BowlingPaymentStepProps {
  /** Tax-inclusive deposit amount to display and charge. */
  depositCents: number;
  /** Tax-inclusive full day-of order total (for "remaining at center" line). */
  totalCents: number;
  /**
   * Location identifier for CardCaptureForm.
   * Accepts "headpinz" | "naples" or a raw Square location ID.
   */
  locationId: string;
  /**
   * Inline error message from a failed reserve/payment API call.
   * Distinct from tokenize errors which are managed internally.
   */
  paymentError: string | null;
  /** True while the parent is submitting (after tokenize) — disables Pay button. */
  busy: boolean;
  /** Heading text. Defaults to "Secure Payment". */
  heading?: string;
  /** Pay button label suffix. Defaults to "Pay {depositCents}". */
  payLabel?: string;
  /** Additional condition that disables the pay button (e.g. !agreed). */
  payDisabled?: boolean;
  /** Called when the user clicks Back. */
  onBack: () => void;
  /**
   * Called with the Square nonce AFTER tokenize completes successfully.
   * The card widget is still mounted when this is called — safe to change
   * step / call the reserve API from here.
   */
  onPay: (token: string) => void;
  /**
   * Optional content rendered between CardCaptureForm and the pay button.
   * Use for ClickwrapCheckbox or other flow-specific elements.
   */
  children?: ReactNode;
}

// ── Square wallet types (same shape as PaymentForm.tsx) ────────────────
interface SquareDigitalWallet {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string }>;
  destroy: () => void;
}

export default function BowlingPaymentStep({
  depositCents,
  totalCents,
  locationId,
  paymentError,
  busy,
  heading = "Secure Payment",
  payLabel,
  payDisabled = false,
  onBack,
  onPay,
  children,
}: BowlingPaymentStepProps) {
  // Card ref is owned here — never exposed to the parent
  const cardRef = useRef<CardCaptureHandle | null>(null);
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenizeError, setTokenizeError] = useState<string | null>(null);

  // ── Digital wallet state ─────────────────────────────────────────
  const [applePayReady, setApplePayReady] = useState(false);
  const applePayRef = useRef<SquareDigitalWallet | null>(null);
  const walletInitRef = useRef(false);

  const remaining = totalCents - depositCents;
  const effectivePayLabel = payLabel ?? `Pay ${centsToDollars(depositCents)}`;
  const isProcessing = tokenizing || busy;

  // ── Initialize Apple Pay + Google Pay ───────────────────────────
  useEffect(() => {
    if (walletInitRef.current || depositCents <= 0) return;
    walletInitRef.current = true;

    let cancelled = false;

    async function initWallets() {
      try {
        // Ensure SDK is loaded
        if (!window.Square) {
          if (!document.querySelector(`script[src="${SDK_URL}"]`)) {
            await new Promise<void>((resolve, reject) => {
              const s = document.createElement("script");
              s.src = SDK_URL;
              s.onload = () => resolve();
              s.onerror = () => reject(new Error("Square SDK failed to load"));
              document.head.appendChild(s);
            });
          }
          // Wait for Square global
          let attempts = 0;
          while (!window.Square && !cancelled && attempts < 40) {
            await new Promise((r) => setTimeout(r, 50));
            attempts++;
          }
        }
        if (cancelled || !window.Square) return;

        const locId = resolveLocationId(locationId);
        const payments = await window.Square.payments(SQUARE_APP_ID, locId);
        const amountStr = (depositCents / 100).toFixed(2);

        // Apple Pay
        try {
          const applePayRequest = payments.paymentRequest({
            countryCode: "US",
            currencyCode: "USD",
            total: { amount: amountStr, label: "HeadPinz Bowling" },
          });
          const applePay = await payments.applePay(applePayRequest);
          if (!cancelled) {
            applePayRef.current = applePay as unknown as SquareDigitalWallet;
            setApplePayReady(true);
          }
        } catch {
          // Apple Pay not available on this device/browser — silent
        }
      } catch {
        // Non-fatal — card form still works
      }
    }

    initWallets();

    return () => {
      cancelled = true;
      try { applePayRef.current?.destroy(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, depositCents]);

  // ── Apple Pay handler ───────────────────────────────────────────
  async function handleApplePay() {
    if (isProcessing || !applePayRef.current) return;
    setTokenizing(true);
    setTokenizeError(null);
    try {
      const result = await (applePayRef.current as unknown as {
        tokenize: () => Promise<{ status: string; token?: string }>;
      }).tokenize();
      if (result.status !== "OK" || !result.token) {
        throw new Error("Apple Pay cancelled or failed");
      }
      onPay(result.token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Apple Pay failed";
      setTokenizeError(msg);
      setTokenizing(false);
    }
  }

  // ── Card Pay handler ────────────────────────────────────────────
  async function handlePay() {
    if (isProcessing || payDisabled) return;
    if (!cardRef.current) {
      setTokenizeError("Card form not ready. Please refresh and try again.");
      return;
    }

    setTokenizing(true);
    setTokenizeError(null);

    const result = await cardRef.current.tokenize();

    if ("error" in result) {
      setTokenizeError(result.error);
      setTokenizing(false);
      return;
    }

    onPay(result.token);
  }

  return (
    <div className="space-y-5">
      <h2 className="font-heading font-black uppercase italic text-white text-xl">
        {heading}
      </h2>

      {/* Deposit summary */}
      <p className="text-white/45 text-sm">
        Deposit due today:{" "}
        <span className="text-white font-semibold">
          {centsToDollars(depositCents)}
        </span>
        {remaining > 0 && (
          <> · Balance at center: {centsToDollars(remaining)}</>
        )}
      </p>

      {/* ── Apple Pay ──────────────────────────────────────────── */}
      {applePayReady && (
        <button
          type="button"
          onClick={() => void handleApplePay()}
          disabled={isProcessing}
          className="w-full h-12 rounded-xl bg-white text-black font-semibold text-sm flex items-center justify-center gap-2 hover:bg-white/90 active:bg-white/80 transition-colors disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
            <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
          </svg>
          Pay with Apple Pay
        </button>
      )}

      {/* Divider between Apple Pay and card */}
      {applePayReady && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-white/30 text-xs uppercase tracking-wider font-body">or pay with card</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>
      )}

      {/* Card form — owned by this component, never exposed via ref */}
      <CardCaptureForm ref={cardRef} locationId={locationId} />

      {/* Tokenize error (card validation failed before API call) */}
      {tokenizeError && (
        <div
          className="rounded-xl p-3 text-sm font-body"
          style={{
            backgroundColor: "rgba(253,91,86,0.12)",
            border: "1.5px solid rgba(253,91,86,0.35)",
            color: CORAL,
          }}
        >
          {tokenizeError}
        </div>
      )}

      {/* Payment API error (returned from reserve/bowling-orders) */}
      {paymentError && (
        <div
          className="rounded-xl p-3 text-sm font-body"
          style={{
            backgroundColor: "rgba(253,91,86,0.12)",
            border: "1.5px solid rgba(253,91,86,0.35)",
            color: CORAL,
          }}
        >
          {paymentError}
        </div>
      )}

      {/* Slot: ClickwrapCheckbox or other flow-specific content */}
      {children}

      {/* Pay button */}
      <button
        type="button"
        disabled={isProcessing || payDisabled}
        onClick={() => void handlePay()}
        className="w-full py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ backgroundColor: CORAL }}
      >
        {isProcessing ? "Processing…" : effectivePayLabel}
      </button>

      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        disabled={isProcessing}
        className="w-full py-2 text-sm font-body text-white/40 hover:text-white/70 transition-colors disabled:opacity-40"
      >
        ← Back
      </button>

      <p className="text-center font-body text-white/20 text-xs">
        Secured by Square. Your card details never touch our servers.
      </p>
    </div>
  );
}
