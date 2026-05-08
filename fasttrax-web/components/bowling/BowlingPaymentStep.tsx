"use client";

import { useRef, useState, type ReactNode } from "react";
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
 * When the user clicks Pay, this component:
 *   1. Calls card.tokenize() (card is still mounted — no risk of INVALID_CARD_DATA)
 *   2. On success, calls onPay(token) — the parent then changes step / calls the API
 *   3. On failure, surfaces tokenizeError inline (no step change needed)
 *
 * The parent should NOT setStep("submitting") before calling onPay; it should
 * do so inside the onPay callback, after tokenize has already completed.
 */

const CORAL = "#fd5b56";

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

  const remaining = totalCents - depositCents;
  const effectivePayLabel = payLabel ?? `Pay ${centsToDollars(depositCents)}`;
  const isProcessing = tokenizing || busy;

  async function handlePay() {
    if (isProcessing || payDisabled) return;
    if (!cardRef.current) {
      setTokenizeError("Card form not ready. Please refresh and try again.");
      return;
    }

    setTokenizing(true);
    setTokenizeError(null);

    // Tokenize while card widget is still mounted — safe here because we
    // haven't changed any parent step state yet.
    const result = await cardRef.current.tokenize();

    if ("error" in result) {
      setTokenizeError(result.error);
      setTokenizing(false);
      return;
    }

    // Token obtained. Card is still mounted at this point.
    // Hand off to parent — parent changes step / calls API from here.
    onPay(result.token);
    // Note: don't reset tokenizing here — the component will unmount when
    // the parent transitions away from the payment step.
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
