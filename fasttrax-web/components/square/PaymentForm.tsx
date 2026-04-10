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
  // Card-on-file (returning racers)
  squareCustomerId?: string;
  savedCards?: SavedCard[];
}

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";
const SQUARE_LOCATION_ID = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID || "";

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
}: PaymentFormProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "processing" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(
    savedCards.filter(c => !c.expired).length > 0 ? savedCards.filter(c => !c.expired)[0].id : null
  );
  const [saveCard, setSaveCard] = useState(false);
  const cardRef = useRef<SquareCard | null>(null);
  const initRef = useRef(false);

  // Load Square SDK and initialize card form
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    async function init() {
      try {
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
        const card = await payments.card({
          style: {
            ".input-container": {
              borderColor: "rgba(255,255,255,0.15)",
              borderRadius: "12px",
            },
            ".input-container.is-focus": {
              borderColor: "#00E2E5",
            },
            ".message-text": {
              color: "rgba(255,255,255,0.5)",
            },
            ".message-icon": {
              color: "#00E2E5",
            },
            input: {
              backgroundColor: "rgba(255,255,255,0.05)",
              color: "#ffffff",
              fontFamily: "sans-serif",
              fontSize: "14px",
            },
            "input::placeholder": {
              color: "rgba(255,255,255,0.3)",
            },
          },
        });

        await card.attach("#sq-card-container");
        cardRef.current = card;
        setStatus("ready");
      } catch (err) {
        console.error("[PaymentForm] init error:", err);
        setStatus("error");
        setErrorMessage("Failed to load payment form. Please refresh and try again.");
      }
    }

    init();

    return () => {
      cardRef.current?.destroy();
    };
  }, []);

  async function handleSubmit() {
    if (status === "processing") return;
    setStatus("processing");
    setErrorMessage(null);

    try {
      let token: string | undefined;
      let usingSavedCard = false;

      if (selectedCardId) {
        // Using saved card — no tokenization needed
        usingSavedCard = true;
        token = selectedCardId;
      } else {
        // Tokenize the card form
        if (!cardRef.current) throw new Error("Card form not ready");
        const result = await cardRef.current.tokenize();
        if (result.status !== "OK" || !result.token) {
          const errMsg = result.errors?.[0]?.message || "Card validation failed";
          throw new Error(errMsg);
        }
        token = result.token;
      }

      // Send to server
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
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || "Payment failed");
      }

      setStatus("success");
      // Brief pause to show success state, then callback
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

      {/* Save card checkbox (returning racers only) */}
      {squareCustomerId && !selectedCardId && (
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
