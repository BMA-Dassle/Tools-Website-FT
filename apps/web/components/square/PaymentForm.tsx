"use client";

import { useState, useEffect, useRef } from "react";
import { clickableDivProps } from "@/lib/a11y";
import SavedCardSelector from "./SavedCardSelector";
import type { SavedCard } from "./SavedCardSelector";
import GiftCardCapture, { type GiftCardCaptureHandle } from "./GiftCardCapture";

declare global {
  interface Window {
    Square?: {
      payments: (appId: string, locationId: string) => Promise<SquarePayments>;
    };
  }
}

interface SquarePayments {
  card: (options?: Record<string, unknown>) => Promise<SquareCard>;
  applePay: (request: unknown) => Promise<SquareDigitalWallet>;
  googlePay: (request: unknown) => Promise<SquareDigitalWallet>;
  giftCard: (options?: Record<string, unknown>) => Promise<unknown>;
  paymentRequest: (config: {
    countryCode: string;
    currencyCode: string;
    total: { amount: string; label: string };
  }) => unknown;
}

interface SquareCard {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string; errors?: { message: string }[] }>;
  destroy: () => void;
}

interface SquareDigitalWallet {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string }>;
  destroy: () => void;
}

export interface PaymentResult {
  paymentId: string;
  orderId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  amount: number;
  receiptUrl: string | null;
  savedCardId: string | null;
  /** Pandora deposit row id, when the server-side post-payment
   *  hook ran addDeposit successfully. */
  depositId?: string;
  /** True when Square charged but the post-payment addDeposit
   *  failed — caller should show "charged, credit pending" UI. */
  depositCreditFailed?: boolean;
  /** Server-side error string when depositCreditFailed. */
  depositError?: string;
  /** Amount (USD cents) that the customer's gift card covered. 0 when
   *  no gift card was used. */
  giftCardAppliedCents?: number;
  /** Last 4 of the gift card GAN, when a GC was used. */
  giftCardLast4?: string | null;
}

/** Optional Square catalog reference for the order line item. Lets
 *  the caller use a custom-name override against a shared catalog
 *  product (e.g. all race-pack variants share one Square SKU). */
export interface PaymentLineItem {
  /** Display name shown on the order line + receipt. */
  name?: string;
  /** Square catalog item or variation id. */
  catalogObjectId?: string;
}

/** Optional post-payment server-side action. Currently only
 *  `addDeposit` — used by the race-packs workaround. The /api/square/pay
 *  endpoint runs the action atomically with the charge so a tab
 *  close between the two can't strand the customer. */
export interface PostPaymentAction {
  kind: "addDeposit";
  personId: string | number;
  depositKindId: string;
  amount: number;
  packLabel?: string;
  raceCount?: number;
  isNewRacer?: boolean;
}

interface PaymentFormProps {
  amount: number;
  itemName: string;
  billId: string;
  contact: { firstName: string; lastName: string; email: string; phone: string };
  /** Override Square location: "fasttrax" | "headpinz" | "naples". Auto-detects from hostname if not set. */
  locationId?: string;
  onSuccess: (result: PaymentResult) => void;
  onError: (error: string) => void;
  onCancel?: () => void;
  // Card-on-file (returning racers only — OTP verified)
  squareCustomerId?: string;
  savedCards?: SavedCard[];
  allowSaveCard?: boolean; // Only true for OTP-verified returning racers
  /** Optional Square catalog reference for the line item — lets
   *  callers point at a real catalog product with a custom name
   *  override (e.g. race packs share `YYOV5QCHQSJKZS7DDIALGU7Z`). */
  lineItem?: PaymentLineItem;
  /** Optional server-side hook fired AFTER Square charges. */
  postPaymentAction?: PostPaymentAction;
  /**
   * Tokenize-only mode: when set, the Pay button tokenizes the card
   * and calls this callback with the nonce(s) instead of POSTing to
   * /api/square/pay. Lets the caller (e.g. v2 CheckoutStep) control
   * the payment flow via /api/booking/v2/reserve.
   */
  onTokenize?: (params: {
    cardNonce: string | null;
    savedCardId: string | null;
    giftCardNonce: string | null;
  }) => Promise<void>;
}

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";

// Square location IDs per site
const SQUARE_LOCATIONS: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

function detectSquareLocationId(overrideLocationId?: string): string {
  if (overrideLocationId && SQUARE_LOCATIONS[overrideLocationId])
    return SQUARE_LOCATIONS[overrideLocationId];
  if (typeof window === "undefined") return SQUARE_LOCATIONS.fasttrax;
  const host = window.location.hostname;
  if (host.includes("headpinz")) return SQUARE_LOCATIONS.headpinz;
  return SQUARE_LOCATIONS.fasttrax;
}

// Send logs to server so they appear in Vercel runtime logs
const logBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function serverLog(msg: string) {
  console.log(msg);
  logBuffer.push(`${new Date().toISOString()} ${msg}`);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = logBuffer.splice(0);
      fetch("/api/debug-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: batch }),
      }).catch(() => {});
    }, 500);
  }
}

export default function PaymentForm({
  amount,
  itemName,
  billId,
  contact,
  locationId: locationIdProp,
  onSuccess,
  onError,
  onCancel,
  squareCustomerId,
  savedCards = [],
  allowSaveCard = false,
  lineItem,
  postPaymentAction,
  onTokenize,
}: PaymentFormProps) {
  const squareLocationId = detectSquareLocationId(locationIdProp);
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "success" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(
    savedCards.filter((c) => !c.expired).length > 0
      ? savedCards.filter((c) => !c.expired)[0].id
      : null,
  );
  const [saveCard, setSaveCard] = useState(false);
  const [applePayReady, setApplePayReady] = useState(false);
  const [googlePayReady, setGooglePayReady] = useState(false);
  const cardRef = useRef<SquareCard | null>(null);
  const applePayRef = useRef<SquareDigitalWallet | null>(null);
  const googlePayRef = useRef<SquareDigitalWallet | null>(null);
  const initRef = useRef(false);
  const giftCardCaptureRef = useRef<GiftCardCaptureHandle | null>(null);
  // Live Square `payments` instance so GiftCardCapture can call
  // payments.giftCard() without spinning up a second SDK instance.
  const [paymentsInstance, setPaymentsInstance] = useState<SquarePayments | null>(null);
  // Gift card entry is collapsed behind a "Have a gift card?" toggle —
  // it's the rarest tender, so it shouldn't take top-of-screen space.
  const [showGiftCard, setShowGiftCard] = useState(false);
  // Applied gift card state. Null = no GC applied.
  const [giftCardNonce, setGiftCardNonce] = useState<string | null>(null);
  const [giftCardBalanceCents, setGiftCardBalanceCents] = useState<number>(0);
  const [giftCardLast4, setGiftCardLast4] = useState<string | null>(null);

  // Cents math for the GC math + split UI. We do math in cents to avoid
  // floating-point drift, then format dollars for display.
  const amountCents = Math.round(amount * 100);
  const gcAppliedCents = Math.min(amountCents, giftCardBalanceCents);
  const remainingCents = Math.max(0, amountCents - gcAppliedCents);
  const remainingDollars = remainingCents / 100;

  // Load Square SDK and initialize card form
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    async function init() {
      try {
        serverLog(
          `[PaymentForm] init start — appId=${SQUARE_APP_ID}, locId=${squareLocationId}, ua=${navigator.userAgent.slice(0, 80)}`,
        );

        // Load SDK if not already loaded
        if (!window.Square) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://web.squarecdn.com/v1/square.js";
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load Square SDK"));
            document.head.appendChild(script);
          });
        }

        if (!window.Square) throw new Error("Square SDK not available");

        const payments = await window.Square.payments(SQUARE_APP_ID, squareLocationId);
        setPaymentsInstance(payments);

        // Initialize card form
        const card = await payments.card();
        await card.attach("#sq-card-container");
        cardRef.current = card;
        serverLog("[PaymentForm] card form attached OK");

        // Initialize Apple Pay (Safari/iOS only)
        try {
          serverLog("[PaymentForm] initializing Apple Pay...");
          const amountStr = amount.toFixed(2);
          const applePayRequest = payments.paymentRequest({
            countryCode: "US",
            currencyCode: "USD",
            total: { amount: amountStr, label: itemName || "FastTrax Booking" },
          });
          serverLog(`[PaymentForm] Apple Pay request created, amount=${amountStr}`);
          const applePay = await payments.applePay(applePayRequest);
          serverLog(
            `[PaymentForm] Apple Pay created, methods=[${Object.keys(applePay).join(",")}]`,
          );
          // Apple Pay has no attach() — it uses native sheet via tokenize()
          // Just store the reference and mark ready
          applePayRef.current = applePay as unknown as SquareDigitalWallet;
          setApplePayReady(true);
          serverLog("[PaymentForm] Apple Pay ready");
        } catch (apErr) {
          serverLog(
            `[PaymentForm] Apple Pay not available: ${apErr instanceof Error ? apErr.message : String(apErr)}`,
          );
        }

        // Initialize Google Pay
        try {
          serverLog("[PaymentForm] initializing Google Pay...");
          const googlePayRequest = payments.paymentRequest({
            countryCode: "US",
            currencyCode: "USD",
            total: { amount: amount.toFixed(2), label: itemName || "FastTrax Booking" },
          });
          const googlePay = await payments.googlePay(googlePayRequest);
          serverLog("[PaymentForm] Google Pay created, attaching...");
          await googlePay.attach("#sq-google-pay");
          googlePayRef.current = googlePay;
          setGooglePayReady(true);
          serverLog("[PaymentForm] Google Pay ready");
        } catch (gpErr) {
          serverLog(
            `[PaymentForm] Google Pay not available: ${gpErr instanceof Error ? gpErr.message : String(gpErr)}`,
          );
        }

        setStatus("ready");
      } catch (err) {
        serverLog(`[PaymentForm] init error: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
        setErrorMessage("Failed to load payment form. Please refresh and try again.");
      }
    }

    init();

    return () => {
      cardRef.current?.destroy();
      applePayRef.current?.destroy();
      googlePayRef.current?.destroy();
    };
  }, []);

  // Wallet tokens are ordinary card nonces — they MUST ride the same rail as
  // typed cards. When `onTokenize` is wired (v2 checkout) the caller's reserve
  // route does the charging AND creates the reservation; charging here instead
  // produced payments with no booking (June 2026 orphan-charge incident).
  async function handleWalletPay(walletRef: SquareDigitalWallet | null, walletName: string) {
    if (status === "processing" || !walletRef) return;
    setStatus("processing");
    setErrorMessage(null);
    try {
      const result = await walletRef.tokenize();
      if (result.status !== "OK" || !result.token)
        throw new Error(`${walletName} cancelled or failed`);
      if (onTokenize) {
        serverLog(`[PaymentForm] ${walletName} token → onTokenize`);
        await onTokenize({
          cardNonce: result.token,
          savedCardId: null,
          giftCardNonce: giftCardNonce ?? null,
        });
        return;
      }
      await processPayment(result.token, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `${walletName} failed`;
      setStatus("error");
      setErrorMessage(msg);
    }
  }

  const handleApplePay = () => handleWalletPay(applePayRef.current, "Apple Pay");
  const handleGooglePay = () => handleWalletPay(googlePayRef.current, "Google Pay");

  async function processPayment(token: string | null, usingSavedCard: boolean) {
    // `token` may be null when the gift card fully covers the bill —
    // no card tokenization needed. The backend authorizes only the GC
    // and skips the card path entirely.
    const res = await fetch("/api/square/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: usingSavedCard ? undefined : (token ?? undefined),
        useSavedCard: usingSavedCard,
        savedCardId: usingSavedCard ? token : undefined,
        giftCardNonce: giftCardNonce ?? undefined,
        amount,
        billId,
        itemName,
        contact,
        saveCard: saveCard && !!squareCustomerId && !usingSavedCard && token != null,
        squareCustomerId,
        locationId:
          locationIdProp ||
          (typeof window !== "undefined" && window.location.hostname.includes("headpinz")
            ? "headpinz"
            : "fasttrax"),
        lineItem,
        postPaymentAction,
      }),
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Payment failed");

    setStatus("success");
    setTimeout(() => {
      onSuccess({
        paymentId: data.paymentId,
        orderId: data.orderId,
        cardBrand: data.cardBrand,
        cardLast4: data.cardLast4,
        amount: data.amount,
        receiptUrl: data.receiptUrl,
        savedCardId: data.savedCardId,
        depositId: data.depositId,
        depositCreditFailed: data.depositCreditFailed,
        depositError: data.depositError,
        giftCardAppliedCents: data.giftCardAppliedCents,
        giftCardLast4: data.giftCardLast4,
      });
    }, 1500);
  }

  async function handleSubmit() {
    if (status === "processing") return;
    setStatus("processing");
    setErrorMessage(null);

    try {
      // GC fully covers — no card needed. Send null token; the backend
      // authorizes the GC alone.
      if (giftCardNonce && remainingCents === 0) {
        if (onTokenize) {
          await onTokenize({ cardNonce: null, savedCardId: null, giftCardNonce });
          return;
        }
        await processPayment(null, false);
        return;
      }
      if (selectedCardId) {
        if (onTokenize) {
          await onTokenize({
            cardNonce: null,
            savedCardId: selectedCardId,
            giftCardNonce: giftCardNonce ?? null,
          });
          return;
        }
        await processPayment(selectedCardId, true);
      } else {
        if (!cardRef.current) throw new Error("Card form not ready");
        const result = await cardRef.current.tokenize();
        if (result.status !== "OK" || !result.token) {
          throw new Error(result.errors?.[0]?.message || "Card validation failed");
        }
        if (onTokenize) {
          await onTokenize({
            cardNonce: result.token,
            savedCardId: null,
            giftCardNonce: giftCardNonce ?? null,
          });
          return;
        }
        await processPayment(result.token, false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Payment failed";
      setStatus("error");
      setErrorMessage(msg);
    }
  }

  // Success state
  if (status === "success") {
    return (
      <div className="text-center py-12 space-y-4">
        <div className="w-16 h-16 rounded-full bg-emerald-500/20 border-2 border-emerald-500/50 flex items-center justify-center mx-auto">
          <svg
            className="w-8 h-8 text-emerald-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-white font-display text-xl uppercase tracking-widest">
          Payment Successful!
        </p>
        <p className="text-white/40 text-sm">Redirecting to your confirmation...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-md mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          Secure Payment
        </h2>
        <p className="text-white/50 text-sm">{itemName}</p>
      </div>

      {/* Express lane first: digital wallets, then the manual card path below
          the divider. Hidden when a GC is applied (v1 mutual exclusion) or a
          saved card is selected (existing behavior, unchanged). */}
      <div
        className={
          !giftCardNonce && !selectedCardId && (applePayReady || googlePayReady)
            ? "space-y-3"
            : "hidden"
        }
      >
        {applePayReady && (
          <button
            onClick={handleApplePay}
            disabled={status === "processing"}
            className="w-full h-11 rounded-lg bg-white text-black font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-white/90 active:bg-white/80 transition-colors disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
            </svg>
            Apple Pay
          </button>
        )}
        {/* Square attach() renders the button but the integrator owns the
            click → tokenize step; without this handler the button is inert. */}
        <div
          id="sq-google-pay"
          {...clickableDivProps(handleGooglePay, "Pay with Google Pay", {
            disabled: status === "processing",
          })}
          className={googlePayReady ? "w-full min-h-[48px] [&_iframe]:!w-full" : "hidden"}
        />
      </div>
      <div id="sq-apple-pay" className="hidden" />
      {!giftCardNonce && !selectedCardId && (applePayReady || googlePayReady) && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-white/30 text-xs uppercase tracking-wider">or pay with card</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>
      )}

      {/* Saved cards (hidden when GC fully covers the bill) */}
      {savedCards.length > 0 && remainingCents > 0 && (
        <SavedCardSelector
          cards={savedCards}
          selectedCardId={selectedCardId}
          onSelect={setSelectedCardId}
        />
      )}

      {/* Card form (hidden when using saved card OR when GC fully covers) */}
      <div className={selectedCardId || remainingCents === 0 ? "hidden" : ""}>
        <div
          id="sq-card-container"
          className="min-h-[100px] rounded-xl"
          style={{ minHeight: status === "loading" ? "120px" : undefined }}
        />
        {status === "loading" && (
          <div className="flex items-center justify-center gap-2 py-4 text-white/40 text-sm">
            <div className="w-4 h-4 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            Loading secure payment...
          </div>
        )}
      </div>

      {/* Save card checkbox (OTP-verified returning racers only). Hidden
          when GC fully covers — no card is being entered. */}
      {allowSaveCard && squareCustomerId && !selectedCardId && remainingCents > 0 && (
        <label className="flex items-center gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={saveCard}
            onChange={(e) => setSaveCard(e.target.checked)}
            className="w-4 h-4 rounded border-white/20 bg-white/5 accent-[#00E2E5]"
          />
          <span className="text-sm text-white/50 group-hover:text-white/70 transition-colors">
            Save this card for future visits
          </span>
        </label>
      )}

      {/* Error message */}
      {errorMessage && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-red-400 text-sm">{errorMessage}</p>
        </div>
      )}

      {/* Pay button */}
      <button
        onClick={handleSubmit}
        disabled={status === "loading" || status === "processing"}
        className="w-full py-4 rounded-xl font-bold text-base bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === "processing" ? (
          <span className="flex items-center justify-center gap-2">
            <div className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
            Processing...
          </span>
        ) : giftCardNonce && remainingCents === 0 ? (
          `Pay $${amount.toFixed(2)} with gift card`
        ) : giftCardNonce ? (
          `Pay $${(gcAppliedCents / 100).toFixed(2)} GC + $${remainingDollars.toFixed(2)} card`
        ) : (
          `Pay $${amount.toFixed(2)}`
        )}
      </button>

      {/* Gift card — rare path, so collapsed to a text toggle until asked
          for. Applied state renders the summary chip in the same slot. */}
      {giftCardNonce ? (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 flex items-start justify-between gap-3">
          <div className="text-sm">
            <p className="text-emerald-200 font-semibold">Gift card •••• {giftCardLast4 ?? ""}</p>
            <p className="text-emerald-200/80 text-xs mt-0.5">
              ${(gcAppliedCents / 100).toFixed(2)} of ${(giftCardBalanceCents / 100).toFixed(2)}{" "}
              balance applied
              {remainingCents > 0 ? ` · $${remainingDollars.toFixed(2)} due on card` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setGiftCardNonce(null);
              setGiftCardBalanceCents(0);
              setGiftCardLast4(null);
              giftCardCaptureRef.current?.reset();
            }}
            disabled={status === "processing"}
            className="text-xs text-white/60 hover:text-white underline disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      ) : showGiftCard ? (
        <GiftCardCapture
          ref={giftCardCaptureRef}
          payments={paymentsInstance}
          disabled={status === "processing"}
          onApply={({ nonce, balanceCents, last4 }) => {
            setGiftCardNonce(nonce);
            setGiftCardBalanceCents(balanceCents);
            setGiftCardLast4(last4);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowGiftCard(true)}
          disabled={status === "processing"}
          className="w-full text-center text-sm text-white/40 underline underline-offset-2 hover:text-white/70 transition-colors disabled:opacity-40"
        >
          Have a gift card?
        </button>
      )}

      {/* Cancel + security note in one compact bottom row */}
      <div
        className={
          onCancel ? "flex items-center justify-between gap-3 text-xs" : "text-center text-xs"
        }
      >
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={status === "processing"}
            className="text-sm text-white/30 hover:text-white/50 transition-colors shrink-0"
          >
            ← Back
          </button>
        )}
        <p className={onCancel ? "text-right text-white/20" : "text-white/20"}>
          Secured by Square. Your card details never touch our servers.
        </p>
      </div>
    </div>
  );
}
