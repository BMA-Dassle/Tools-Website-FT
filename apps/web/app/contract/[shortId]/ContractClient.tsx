"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Square types are declared globally in components/square/PaymentForm.tsx

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";

interface QuoteProps {
  id: number;
  contractShortId: string;
  pandadocDocumentId: string | null;
  contractStatus: string | null;
  status: string;
  brand: "headpinz" | "fasttrax";
  centerName: string;
  squareLocationId: string;
  eventName: string;
  eventDateDisplay: string;
  eventDate: string;
  guestCount: number | null;
  notes: string | null;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string | null;
  plannerFirst: string | null;
  plannerLast: string | null;
  plannerEmail: string | null;
  plannerPhone: string | null;
  totalCents: number;
  taxCents: number;
  depositDueCents: number;
  balanceCents: number;
  lineItems: Array<{ name: string; price: number; qty: number; total: number }>;
  depositPaidAt: string | null;
  giftCardGan: string | null;
}

type Phase = "sign" | "pay" | "done";

export default function ContractClient({ quote }: { quote: QuoteProps }) {
  const [phase, setPhase] = useState<Phase>(() => {
    if (quote.depositPaidAt) return "done";
    if (quote.contractStatus === "signed") return "pay";
    return "sign";
  });
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saveCard, setSaveCard] = useState(true);
  const [giftCardGan, setGiftCardGan] = useState(quote.giftCardGan);
  const cardRef = useRef<{
    tokenize: () => Promise<{
      status: string;
      token?: string;
      errors?: Array<{ message: string }>;
    }>;
    destroy: () => void;
  } | null>(null);
  const squareLoaded = useRef(false);

  const accent =
    quote.brand === "headpinz" ? "from-rose-600 to-orange-500" : "from-cyan-500 to-blue-600";
  const accentSolid = quote.brand === "headpinz" ? "bg-rose-600" : "bg-cyan-600";
  const accentText = quote.brand === "headpinz" ? "text-rose-400" : "text-cyan-400";

  // Load Square SDK when entering pay phase
  useEffect(() => {
    if (phase !== "pay" || squareLoaded.current) return;
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
        await card.attach("#sq-card-container");
        cardRef.current = card;
      } catch (err) {
        console.error("Square SDK load failed:", err);
        setError("Failed to load payment form. Please refresh and try again.");
      }
    })();

    return () => {
      try {
        cardRef.current?.destroy();
      } catch {
        /* cleanup */
      }
    };
  }, [phase, quote.squareLocationId]);

  // Listen for PandaDoc completion postMessage
  useEffect(() => {
    if (phase !== "sign") return;
    const handler = (evt: MessageEvent) => {
      if (typeof evt.data === "object" && evt.data?.event === "session_view.document.completed") {
        setPhase("pay");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [phase]);

  const handlePay = useCallback(async () => {
    if (!cardRef.current) {
      setError("Payment form not ready. Please wait a moment.");
      return;
    }
    setError(null);
    setProcessing(true);

    try {
      const result = await cardRef.current.tokenize();
      if (result.status !== "OK" || !result.token) {
        setError(result.errors?.[0]?.message || "Card validation failed. Please try again.");
        setProcessing(false);
        return;
      }

      const res = await fetch("/api/group-function/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractShortId: quote.contractShortId,
          cardSourceId: result.token,
          saveCard,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Payment failed. Please try again.");
        setProcessing(false);
        return;
      }

      setGiftCardGan(data.giftCardGan);
      setPhase("done");
    } catch {
      setError("Payment processing failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  }, [quote.contractShortId, saveCard]);

  const fmtDollars = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Hero */}
      <div className="mb-8 text-center">
        <h1 className="mb-2 text-3xl font-bold md:text-4xl">
          {phase === "done" ? "You're All Set!" : `${quote.guestFirstName}, let's lock this in!`}
        </h1>
        <p className="text-lg text-gray-300">{quote.centerName}</p>
      </div>

      {/* Event summary card */}
      <div className="mb-8 rounded-xl border border-white/10 bg-white/5 p-6">
        <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-gray-400">Event</p>
            <p className="font-semibold">{quote.eventName}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-400">Date</p>
            <p className="font-semibold">{quote.eventDateDisplay}</p>
          </div>
          {quote.guestCount && (
            <div>
              <p className="text-xs uppercase text-gray-400">Guests</p>
              <p className="font-semibold">{quote.guestCount}</p>
            </div>
          )}
          <div>
            <p className="text-xs uppercase text-gray-400">Total</p>
            <p className="font-semibold">{fmtDollars(quote.totalCents)}</p>
          </div>
        </div>

        {/* Line items */}
        <div className="space-y-1 border-t border-white/10 pt-3">
          {quote.lineItems.map((item, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-gray-300">
                {item.name} x{item.qty}
              </span>
              <span>{fmtDollars(Math.round(item.total * 100))}</span>
            </div>
          ))}
          {quote.taxCents > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-300">Tax</span>
              <span>{fmtDollars(quote.taxCents)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Planner block */}
      {quote.plannerFirst && (
        <div className="mb-8 rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase text-gray-400">Your Event Planner</p>
          <p className="text-lg font-semibold">
            {quote.plannerFirst} {quote.plannerLast}
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {quote.plannerPhone && (
              <a
                href={`tel:${quote.plannerPhone}`}
                className={`rounded-full px-4 py-1.5 text-sm font-medium ${accentSolid} text-white`}
              >
                Call
              </a>
            )}
            {quote.plannerPhone && (
              <a
                href={`sms:${quote.plannerPhone}`}
                className="rounded-full border border-white/20 px-4 py-1.5 text-sm font-medium"
              >
                Text
              </a>
            )}
            {quote.plannerEmail && (
              <a
                href={`mailto:${quote.plannerEmail}`}
                className="rounded-full border border-white/20 px-4 py-1.5 text-sm font-medium"
              >
                Email
              </a>
            )}
          </div>
        </div>
      )}

      {/* Phase A: Sign */}
      {phase === "sign" && quote.pandadocDocumentId && (
        <div className="mb-8">
          <h2 className="mb-4 text-xl font-bold">Review & Sign Your Contract</h2>
          <div className="overflow-hidden rounded-xl border border-white/10">
            <iframe
              src={`https://app.pandadoc.com/s/${quote.pandadocDocumentId}`}
              className="h-[600px] w-full"
              title="PandaDoc Contract"
              allow="clipboard-write"
            />
          </div>
          <p className="mt-2 text-center text-xs text-gray-500">
            After signing, you&apos;ll be prompted to pay your deposit.
          </p>
        </div>
      )}

      {/* Phase B: Pay */}
      {phase === "pay" && (
        <div className="mb-8">
          <div
            className={`mb-4 rounded-lg bg-gradient-to-r ${accent} p-3 text-center font-semibold`}
          >
            Contract Signed!
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h2 className="mb-2 text-xl font-bold">Pay Your Deposit</h2>
            <p className="mb-4 text-gray-300">
              Deposit amount:{" "}
              <span className="text-2xl font-bold text-white">
                {fmtDollars(quote.depositDueCents)}
              </span>
            </p>
            {quote.balanceCents > 0 && (
              <p className="mb-4 text-sm text-gray-400">
                Remaining balance of {fmtDollars(quote.balanceCents)} will be charged 72 hours
                before your event.
              </p>
            )}

            <div id="sq-card-container" className="mb-4 min-h-[50px] rounded-lg bg-white p-3" />

            <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={saveCard}
                onChange={(e) => setSaveCard(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              Save card for remaining balance charge
            </label>

            {error && (
              <div className="mb-4 rounded-lg bg-red-900/50 px-4 py-2 text-sm text-red-200">
                {error}
              </div>
            )}

            <button
              onClick={handlePay}
              disabled={processing}
              className={`w-full rounded-lg bg-gradient-to-r ${accent} px-6 py-3 text-lg font-bold text-white transition-opacity disabled:opacity-50`}
            >
              {processing ? "Processing..." : `Pay ${fmtDollars(quote.depositDueCents)} Deposit`}
            </button>
          </div>
        </div>
      )}

      {/* Phase C: Done */}
      {phase === "done" && (
        <div className="mb-8 text-center">
          <div
            className={`mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-r ${accent}`}
          >
            <svg
              className="h-10 w-10 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h2 className="mb-2 text-2xl font-bold">Deposit Confirmed!</h2>
          <p className="mb-6 text-gray-300">
            Your deposit of {fmtDollars(quote.depositDueCents)} has been received. Your planner will
            be in touch with the details.
          </p>

          {giftCardGan && (
            <div className="mx-auto mb-6 inline-block rounded-lg border border-white/10 bg-white/5 px-6 py-3">
              <p className="text-xs uppercase text-gray-400">Reference Number</p>
              <p className={`text-xl font-mono font-bold ${accentText}`}>{giftCardGan}</p>
            </div>
          )}

          {/* Countdown to event */}
          <EventCountdown eventDate={quote.eventDate} />

          <div className="mt-6 flex justify-center gap-3">
            <a
              href={`data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(quote))}`}
              download={`${quote.eventName || "Event"}.ics`}
              className="rounded-full border border-white/20 px-5 py-2 text-sm font-medium transition-colors hover:bg-white/10"
            >
              Add to Calendar
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function EventCountdown({ eventDate }: { eventDate: string }) {
  const [diff, setDiff] = useState("");

  useEffect(() => {
    const update = () => {
      const now = Date.now();
      const target = new Date(eventDate).getTime();
      const ms = target - now;
      if (ms <= 0) {
        setDiff("Event day!");
        return;
      }
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      const mins = Math.floor((ms % 3_600_000) / 60_000);
      setDiff(days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m`);
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [eventDate]);

  if (!diff) return null;

  return (
    <div className="mb-4">
      <p className="text-sm text-gray-400">Countdown to your event</p>
      <p className="text-3xl font-bold tabular-nums">{diff}</p>
    </div>
  );
}

function buildIcs(quote: QuoteProps): string {
  const start = new Date(quote.eventDate);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const fmt = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${quote.eventName || "Group Event"} at ${quote.centerName}`,
    `DESCRIPTION:Event at ${quote.centerName}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
