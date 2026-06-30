"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  IconCircleCheck,
  IconCreditCard,
  IconReceipt,
  IconAlertTriangle,
  IconExternalLink,
} from "@tabler/icons-react";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import {
  buildVerificationDetails,
  type SquareVerificationDetails,
} from "@/lib/square-verification-details";

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";

// window.Square is globally declared in components/square/PaymentForm.tsx.

interface BalancePayQuote {
  contractShortId: string;
  centerName: string;
  squareLocationId: string;
  eventName: string;
  eventNumber: string | null;
  eventDateDisplay: string;
  guestFirstName: string;
  totalCents: number;
  depositDueCents: number;
  balanceCents: number;
  balancePaidAt: string | null;
  plannerFirst: string | null;
  plannerEmail: string | null;
  savedCardLast4: string | null;
  savedCardBrand: string | null;
  hasSavedCard: boolean;
  declineMessage: string | null;
  declinedAt: string | null;
  state: "pay" | "paid" | "contract" | "closed";
}

const fmtDollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default function BalancePayClient({ quote }: { quote: BalancePayQuote }) {
  const [processing, setProcessing] = useState(false);
  const [recharging, setRecharging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Decline reason persisted from the failed auto-charge (or a prior retry here).
  const [declineMessage, setDeclineMessage] = useState<string | null>(quote.declineMessage);
  const [paid, setPaid] = useState(quote.state === "paid");
  const [paidLast4, setPaidLast4] = useState<string | null>(null);
  const squareLoaded = useRef(false);
  const cardRef = useRef<{
    tokenize: (verificationDetails?: SquareVerificationDetails) => Promise<{
      status: string;
      token?: string;
      errors?: Array<{ message: string }>;
    }>;
    destroy: () => void;
  } | null>(null);

  useEffect(() => {
    clarityTag("booking_flow", "group_balance_pay");
    clarityEvent("balance_pay:opened");
  }, []);

  // Load Square card form (only when there is something to pay)
  useEffect(() => {
    if (quote.state !== "pay" || paid || squareLoaded.current) return;
    squareLoaded.current = true;
    (async () => {
      try {
        if (!window.Square) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://web.squarecdn.com/v1/square.js";
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load Square SDK"));
            document.head.appendChild(script);
          });
        }
        const payments = await window.Square!.payments(SQUARE_APP_ID, quote.squareLocationId);
        const card = await payments.card();
        await card.attach("#sq-balance-card-container");
        cardRef.current = card;
      } catch {
        setError("Failed to load payment form. Please refresh.");
      }
    })();
    return () => {
      try {
        cardRef.current?.destroy();
      } catch {
        /* */
      }
    };
  }, [quote.state, paid, quote.squareLocationId]);

  // Shared POST → balance-pay. body carries either a new card token or useSavedCard.
  const submitPayment = useCallback(
    async (body: { cardSourceId?: string; useSavedCard?: boolean }): Promise<boolean> => {
      const res = await fetch("/api/group-function/balance-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractShortId: quote.contractShortId, ...body }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        // A fresh decline updates the reason banner; other errors show inline.
        if (data.declined && data.error) setDeclineMessage(data.error);
        setError(data.error || "Payment failed.");
        return false;
      }
      setDeclineMessage(null);
      setPaidLast4(data.cardLast4 ?? null);
      setPaid(true);
      clarityEvent("balance_pay:paid");
      return true;
    },
    [quote.contractShortId],
  );

  const handlePay = useCallback(async () => {
    if (!cardRef.current) {
      setError("Payment form not ready.");
      return;
    }
    setError(null);
    setProcessing(true);
    try {
      const result = await cardRef.current.tokenize(
        buildVerificationDetails({
          intent: "CHARGE",
          amountDollars: quote.balanceCents / 100,
          contact: { firstName: quote.guestFirstName },
        }),
      );
      if (result.status !== "OK" || !result.token) {
        setError(result.errors?.[0]?.message || "Card validation failed.");
        return;
      }
      await submitPayment({ cardSourceId: result.token });
    } catch {
      setError("Payment processing failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  }, [submitPayment]);

  const handleRecharge = useCallback(async () => {
    setError(null);
    setRecharging(true);
    try {
      await submitPayment({ useSavedCard: true });
    } catch {
      setError("Payment processing failed. Please try again.");
    } finally {
      setRecharging(false);
    }
  }, [submitPayment]);

  return (
    <main className="mx-auto max-w-lg px-4 pt-36 pb-16">
      <div className="rounded-2xl bg-white/5 p-6 ring-1 ring-white/10 sm:p-8">
        <p className="mb-1 text-xs font-bold tracking-widest text-cyan-400 uppercase">
          {quote.centerName}
        </p>
        <h1 className="mb-1 text-2xl font-bold">{quote.eventName || "Your Event"}</h1>
        <p className="mb-3 text-sm text-gray-400">
          {quote.eventDateDisplay}
          {quote.eventNumber ? ` · #${quote.eventNumber}` : ""}
        </p>
        <a
          href={`/contract/${quote.contractShortId}`}
          target="_blank"
          rel="noopener"
          className="mb-6 inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/5"
        >
          <IconExternalLink className="h-3.5 w-3.5 text-cyan-400" /> View event details
        </a>

        {quote.state === "contract" ? (
          <>
            <p className="mb-5 text-sm text-gray-300">
              This event doesn&apos;t have its deposit paid yet. Please review and sign your
              contract first — the deposit is collected there.
            </p>
            <Link
              href={`/contract/${quote.contractShortId}`}
              className="block w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-4 text-center text-lg font-bold text-white shadow-lg shadow-cyan-500/20"
            >
              View &amp; Sign Contract
            </Link>
          </>
        ) : quote.state === "closed" ? (
          <p className="text-sm text-gray-300">
            This event isn&apos;t accepting online payments right now. Please{" "}
            {quote.plannerEmail ? (
              <a href={`mailto:${quote.plannerEmail}`} className="text-cyan-400">
                contact {quote.plannerFirst || "your planner"}
              </a>
            ) : (
              <span>contact {quote.centerName}</span>
            )}{" "}
            for assistance.
          </p>
        ) : paid ? (
          <>
            <div className="mb-5 flex items-center gap-3 rounded-xl bg-emerald-500/10 p-4 ring-1 ring-emerald-400/20">
              <IconCircleCheck className="h-8 w-8 flex-shrink-0 text-emerald-400" />
              <div>
                <p className="font-bold text-emerald-300">You&apos;re all set!</p>
                <p className="text-sm text-gray-300">
                  Your balance is paid in full{paidLast4 ? ` (card ending ${paidLast4})` : ""}. A
                  receipt is on its way to your email.
                </p>
              </div>
            </div>
            <div className="rounded-xl bg-white/5 p-4 text-sm text-gray-300">
              <div className="flex justify-between py-1">
                <span>Event total</span>
                <span className="font-semibold text-white">{fmtDollars(quote.totalCents)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Paid</span>
                <span className="font-semibold text-emerald-400">
                  {fmtDollars(quote.totalCents)}
                </span>
              </div>
              <div className="flex justify-between border-t border-white/10 py-1">
                <span>Balance due</span>
                <span className="font-semibold text-white">$0.00</span>
              </div>
            </div>
            <p className="mt-5 text-center text-sm text-gray-400">
              We&apos;re looking forward to hosting you at {quote.centerName}!
            </p>
          </>
        ) : (
          <>
            <div className="mb-5 rounded-xl bg-white/5 p-4 text-sm text-gray-300">
              <div className="flex justify-between py-1">
                <span>Event total</span>
                <span className="font-semibold text-white">{fmtDollars(quote.totalCents)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Already paid</span>
                <span className="font-semibold text-emerald-400">
                  {fmtDollars(quote.totalCents - quote.balanceCents)}
                </span>
              </div>
              <div className="flex justify-between border-t border-white/10 py-1 text-base">
                <span className="flex items-center gap-1.5">
                  <IconReceipt className="h-4 w-4 text-cyan-400" /> Balance due
                </span>
                <span className="font-bold text-white">{fmtDollars(quote.balanceCents)}</span>
              </div>
            </div>

            {/* Decline reason (from the failed auto-charge or a prior retry here) */}
            {declineMessage && (
              <div className="mb-5 flex items-start gap-3 rounded-xl bg-red-900/30 p-4 ring-1 ring-red-500/30">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
                <div>
                  <p className="text-sm font-bold text-red-200">
                    {quote.savedCardLast4
                      ? `Your ${quote.savedCardBrand || "card"} ending in ${quote.savedCardLast4} was declined`
                      : "Your card was declined"}
                  </p>
                  <p className="mt-0.5 text-sm text-red-200/80">{declineMessage}</p>
                </div>
              </div>
            )}

            {/* Re-charge the saved card (useful if the decline was temporary). */}
            {quote.hasSavedCard && (
              <>
                <button
                  onClick={handleRecharge}
                  disabled={recharging || processing}
                  className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-cyan-500/20 disabled:opacity-50"
                >
                  {recharging
                    ? "Processing..."
                    : `Retry ${quote.savedCardBrand || "card"}${quote.savedCardLast4 ? ` ending ${quote.savedCardLast4}` : " on file"}`}
                </button>
                <div className="my-5 flex items-center gap-3 text-xs text-gray-500">
                  <span className="h-px flex-1 bg-white/10" />
                  OR USE A DIFFERENT CARD
                  <span className="h-px flex-1 bg-white/10" />
                </div>
              </>
            )}

            <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-gray-200">
              <IconCreditCard className="h-4 w-4 text-cyan-400" /> Card details
            </p>
            <div
              id="sq-balance-card-container"
              className="mb-4 min-h-[50px] rounded-lg bg-white p-3"
            />

            {error && (
              <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-200 ring-1 ring-red-500/20">
                {error}
              </div>
            )}

            <button
              onClick={handlePay}
              disabled={processing || recharging}
              className={`w-full rounded-xl px-6 py-4 text-lg font-bold text-white disabled:opacity-50 ${
                quote.hasSavedCard
                  ? "border border-white/15 bg-white/5 hover:bg-white/10"
                  : "bg-gradient-to-r from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20"
              }`}
            >
              {processing
                ? "Processing..."
                : `Pay ${fmtDollars(quote.balanceCents)}${quote.hasSavedCard ? " with this card" : ""}`}
            </button>
            <p className="mt-3 text-center text-xs text-gray-500">
              Secure payment processed by Square. Questions?{" "}
              {quote.plannerEmail ? (
                <a href={`mailto:${quote.plannerEmail}`} className="text-cyan-400">
                  Contact {quote.plannerFirst || "your planner"}
                </a>
              ) : (
                <span>Contact {quote.centerName}</span>
              )}
              .
            </p>
          </>
        )}
      </div>
    </main>
  );
}
