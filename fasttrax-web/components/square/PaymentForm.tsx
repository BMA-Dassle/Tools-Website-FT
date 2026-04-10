"use client";

import { useState, useEffect, useRef } from "react";
import SavedCardSelector from "./SavedCardSelector";
import type { SavedCard } from "./SavedCardSelector";

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
  paymentRequest: (config: { countryCode: string; currencyCode: string; total: { amount: string; label: string } }) => unknown;
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
}

interface PaymentFormProps {
  amount: number;
  itemName: string;
  billId: string;
  contact: { firstName: string; lastName: string; email: string; phone: string };
  onSuccess: (result: PaymentResult) => void;
  onError: (error: string) => void;
  onCancel?: () => void;
  // Card-on-file (returning racers only — OTP verified)
  squareCustomerId?: string;
  savedCards?: SavedCard[];
  allowSaveCard?: boolean;  // Only true for OTP-verified returning racers
}

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";
const SQUARE_LOCATION_ID = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID || "";

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
  onSuccess,
  onError,
  onCancel,
  squareCustomerId,
  savedCards = [],
  allowSaveCard = false,
}: PaymentFormProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(
    savedCards.filter(c => !c.expired).length > 0 ? savedCards.filter(c => !c.expired)[0].id : null
  );
  const [saveCard, setSaveCard] = useState(false);
  const [applePayReady, setApplePayReady] = useState(false);
  const [googlePayReady, setGooglePayReady] = useState(false);
  const cardRef = useRef<SquareCard | null>(null);
  const applePayRef = useRef<SquareDigitalWallet | null>(null);
  const googlePayRef = useRef<SquareDigitalWallet | null>(null);
  const initRef = useRef(false);

  // Load Square SDK and initialize card form
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    async function init() {
      try {
        serverLog(`[PaymentForm] init start — appId=${SQUARE_APP_ID}, locId=${SQUARE_LOCATION_ID}, ua=${navigator.userAgent.slice(0, 80)}`);

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

        const payments = await window.Square.payments(SQUARE_APP_ID, SQUARE_LOCATION_ID);

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
          serverLog(`[PaymentForm] Apple Pay created, methods=[${Object.keys(applePay).join(",")}]`);
          // Apple Pay has no attach() — it uses native sheet via tokenize()
          // Just store the reference and mark ready
          applePayRef.current = applePay as unknown as SquareDigitalWallet;
          setApplePayReady(true);
          serverLog("[PaymentForm] Apple Pay ready");
        } catch (apErr) {
          serverLog(`[PaymentForm] Apple Pay not available: ${apErr instanceof Error ? apErr.message : String(apErr)}`);
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
          serverLog(`[PaymentForm] Google Pay not available: ${gpErr instanceof Error ? gpErr.message : String(gpErr)}`);
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

  async function handleApplePay() {
    if (status === "processing" || !applePayRef.current) return;
    setStatus("processing");
    setErrorMessage(null);
    try {
      const result = await (applePayRef.current as unknown as { tokenize: () => Promise<{ status: string; token?: string }> }).tokenize();
      if (result.status !== "OK" || !result.token) throw new Error("Apple Pay cancelled or failed");
      await processPayment(result.token, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Apple Pay failed";
      setStatus("error");
      setErrorMessage(msg);
    }
  }

  async function processPayment(token: string, usingSavedCard: boolean) {
    const res = await fetch("/api/square/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: usingSavedCard ? undefined : token,
        useSavedCard: usingSavedCard,
        savedCardId: usingSavedCard ? token : undefined,
        amount,
        billId,
        itemName,
        contact,
        saveCard: saveCard && !!squareCustomerId && !usingSavedCard,
        squareCustomerId,
        locationId: typeof window !== "undefined" && window.location.hostname.includes("headpinz") ? "headpinz" : "fasttrax",
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
      });
    }, 1500);
  }

  async function handleSubmit() {
    if (status === "processing") return;
    setStatus("processing");
    setErrorMessage(null);

    try {
      if (selectedCardId) {
        await processPayment(selectedCardId, true);
      } else {
        if (!cardRef.current) throw new Error("Card form not ready");
        const result = await cardRef.current.tokenize();
        if (result.status !== "OK" || !result.token) {
          throw new Error(result.errors?.[0]?.message || "Card validation failed");
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
          <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-white font-display text-xl uppercase tracking-widest">Payment Successful!</p>
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

      {/* Saved cards */}
      {savedCards.length > 0 && (
        <SavedCardSelector
          cards={savedCards}
          selectedCardId={selectedCardId}
          onSelect={setSelectedCardId}
        />
      )}

      {/* Digital wallets */}
      {!selectedCardId && applePayReady && (
        <button
          onClick={handleApplePay}
          disabled={status === "processing"}
          className="w-full h-12 rounded-xl bg-black text-white font-medium text-base flex items-center justify-center gap-2 hover:bg-black/90 transition-colors disabled:opacity-50"
          style={{ WebkitAppearance: "none" }}
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
          Pay
        </button>
      )}
      <div id="sq-apple-pay" className="hidden" />
      <div id="sq-google-pay" className={!selectedCardId && googlePayReady ? "min-h-[48px]" : "hidden"} />
      {!selectedCardId && (applePayReady || googlePayReady) && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-white/30 text-xs uppercase tracking-wider">or pay with card</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>
      )}

      {/* Card form (hidden when using saved card) */}
      <div className={selectedCardId ? "hidden" : ""}>
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

      {/* Save card checkbox (OTP-verified returning racers only) */}
      {allowSaveCard && squareCustomerId && !selectedCardId && (
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
        ) : (
          `Pay $${amount.toFixed(2)}`
        )}
      </button>

      {/* Cancel */}
      {onCancel && (
        <button
          onClick={onCancel}
          disabled={status === "processing"}
          className="w-full text-center text-sm text-white/30 hover:text-white/50 transition-colors"
        >
          ← Back
        </button>
      )}

      {/* Security note */}
      <p className="text-center text-white/20 text-xs">
        Secured by Square. Your card details never touch our servers.
      </p>
    </div>
  );
}
