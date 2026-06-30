"use client";

/**
 * Add-guests card for the combo confirmation page. Lets a customer add more
 * people to a booked Ultimate VIP Experience and pay — books additional BMI
 * heats + a bowling seat/lane via /api/book/add-on/*. Self-contained; rendered
 * only when the booking's combo is addon-enabled (gated upstream).
 *
 * Reuses the Square Web Payments tokenization pattern from BalancePayClient.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconUserPlus,
  IconCircleCheck,
  IconCreditCard,
  IconAlertTriangle,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";

// window.Square is globally declared in components/square/PaymentForm.tsx.

interface Guest {
  firstName: string;
  lastName: string;
}
interface QuoteResponse {
  comboName: string;
  eventDate: string;
  lane: string | null;
  squareLocationId: string;
  quote: { addCount: number; perPersonCents: number; totalCents: number; weekend: boolean };
  capacity: { ok: boolean; lanesToAdd: number; maxAddable: number; blockedReason?: string };
}

const fmt = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default function AddGuestsCard({
  billId,
  comboName,
  accentColor = "#FFD700",
}: {
  billId: string;
  comboName: string;
  accentColor?: string;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(1);
  const [guests, setGuests] = useState<Guest[]>([{ firstName: "", lastName: "" }]);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState(false);

  const squareLoaded = useRef(false);
  const cardRef = useRef<{
    tokenize: () => Promise<{
      status: string;
      token?: string;
      errors?: Array<{ message: string }>;
    }>;
    destroy: () => void;
  } | null>(null);
  const idempotencyKey = useRef(
    `addon-${billId}-${Math.floor(Date.now() / 1000)}-${Math.round(Math.random() * 1e6)}`,
  );

  // Keep the guest-name rows in sync with the count.
  useEffect(() => {
    setGuests((prev) => {
      const next = prev.slice(0, count);
      while (next.length < count) next.push({ firstName: "", lastName: "" });
      return next;
    });
  }, [count]);

  // Fetch a fresh quote whenever the count changes (read-only, safe).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuoting(true);
    setError(null);
    fetch("/api/book/add-on/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billId, guestCount: count }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (!ok) {
          setError(d.error || "Couldn't price that.");
          setQuote(null);
        } else {
          setQuote(d as QuoteResponse);
        }
      })
      .catch(() => !cancelled && setError("Couldn't reach the server."))
      .finally(() => !cancelled && setQuoting(false));
    return () => {
      cancelled = true;
    };
  }, [open, count, billId]);

  // Mount the Square card form once a payable quote is available.
  const canPay = !!quote?.capacity.ok && !done;
  useEffect(() => {
    if (!canPay || !quote || squareLoaded.current) return;
    squareLoaded.current = true;
    (async () => {
      try {
        if (!window.Square) {
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://web.squarecdn.com/v1/square.js";
            s.onload = () => resolve();
            s.onerror = () => reject(new Error("Failed to load Square SDK"));
            document.head.appendChild(s);
          });
        }
        const payments = await window.Square!.payments(SQUARE_APP_ID, quote.squareLocationId);
        const card = await payments.card();
        await card.attach("#sq-addon-card-container");
        cardRef.current = card;
      } catch {
        setError("Couldn't load the payment form. Please refresh.");
      }
    })();
    return () => {
      try {
        cardRef.current?.destroy();
      } catch {
        /* */
      }
      cardRef.current = null;
      squareLoaded.current = false;
    };
  }, [canPay, quote]);

  const handlePay = useCallback(async () => {
    if (!cardRef.current) {
      setError("Payment form not ready.");
      return;
    }
    if (guests.some((g) => !g.firstName.trim())) {
      setError("Please enter each guest's first name.");
      return;
    }
    setError(null);
    setPaying(true);
    try {
      const tok = await cardRef.current.tokenize();
      if (tok.status !== "OK" || !tok.token) {
        setError(tok.errors?.[0]?.message || "Card validation failed.");
        return;
      }
      const res = await fetch("/api/book/add-on/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billId,
          guests: guests.map((g) => ({
            firstName: g.firstName.trim(),
            lastName: g.lastName.trim(),
          })),
          paymentToken: tok.token,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "We couldn't add those guests.");
        return;
      }
      setDone(true);
    } catch {
      setError("Payment processing failed. Please try again.");
    } finally {
      setPaying(false);
    }
  }, [guests, billId]);

  if (done) {
    return (
      <div className="mt-6 rounded-2xl bg-emerald-500/10 p-5 ring-1 ring-emerald-400/20">
        <div className="flex items-center gap-3">
          <IconCircleCheck className="h-7 w-7 flex-shrink-0 text-emerald-400" />
          <div>
            <p className="font-bold text-emerald-300">Guests added!</p>
            <p className="text-sm text-gray-300">
              We&apos;ve added {count} {count === 1 ? "guest" : "guests"} to your {comboName}. A
              receipt is on its way, and our team has the updated party.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-2xl bg-white/5 p-5 ring-1 ring-white/10">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2 font-semibold text-white">
            <IconUserPlus className="h-5 w-5" style={{ color: accentColor }} />
            Add guests to your {comboName}
          </span>
          <span className="text-sm text-gray-400">Add &amp; pay online</span>
        </button>
      ) : (
        <>
          <p className="mb-1 flex items-center gap-2 font-semibold text-white">
            <IconUserPlus className="h-5 w-5" style={{ color: accentColor }} />
            Add guests
          </p>
          <p className="mb-4 text-sm text-gray-400">
            Everyone runs the same races and bowls in your VIP suite — license, POV video and shoes
            included, just like your booking.
          </p>

          {/* Count stepper */}
          <div className="mb-4 flex items-center gap-4">
            <span className="text-sm text-gray-300">How many guests?</span>
            <div className="flex items-center gap-3">
              <button
                aria-label="Fewer"
                onClick={() => setCount((c) => Math.max(1, c - 1))}
                className="rounded-full bg-white/10 p-1.5 hover:bg-white/20"
              >
                <IconMinus className="h-4 w-4 text-white" />
              </button>
              <span className="w-6 text-center text-lg font-bold text-white">{count}</span>
              <button
                aria-label="More"
                onClick={() => setCount((c) => c + 1)}
                className="rounded-full bg-white/10 p-1.5 hover:bg-white/20"
              >
                <IconPlus className="h-4 w-4 text-white" />
              </button>
            </div>
          </div>

          {/* Guest names */}
          <div className="mb-4 space-y-2">
            {guests.map((g, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={g.firstName}
                  onChange={(e) =>
                    setGuests((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, firstName: e.target.value } : x)),
                    )
                  }
                  placeholder={`Guest ${i + 1} first name`}
                  className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-white placeholder-gray-500 ring-1 ring-white/10 focus:ring-white/30 focus:outline-none"
                />
                <input
                  value={g.lastName}
                  onChange={(e) =>
                    setGuests((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, lastName: e.target.value } : x)),
                    )
                  }
                  placeholder="Last name"
                  className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-white placeholder-gray-500 ring-1 ring-white/10 focus:ring-white/30 focus:outline-none"
                />
              </div>
            ))}
          </div>

          {/* Quote / capacity */}
          {quoting && <p className="mb-4 text-sm text-gray-400">Checking availability…</p>}
          {quote && !quote.capacity.ok && (
            <div className="mb-4 flex items-start gap-3 rounded-xl bg-amber-500/10 p-4 ring-1 ring-amber-400/20">
              <IconAlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
              <p className="text-sm text-amber-200">
                {quote.capacity.blockedReason ?? "We can't add that many online."}
                {quote.capacity.maxAddable > 0 && (
                  <>
                    {" "}
                    <button
                      onClick={() => setCount(quote.capacity.maxAddable)}
                      className="underline"
                    >
                      Add {quote.capacity.maxAddable} instead
                    </button>
                    .
                  </>
                )}
              </p>
            </div>
          )}
          {quote && quote.capacity.ok && (
            <div className="mb-4 rounded-xl bg-white/5 p-4 text-sm text-gray-300">
              <div className="flex justify-between py-1">
                <span>
                  {count} {count === 1 ? "guest" : "guests"} × {fmt(quote.quote.perPersonCents)}
                </span>
                <span className="font-semibold text-white">{fmt(quote.quote.totalCents)}</span>
              </div>
              {quote.capacity.lanesToAdd > 0 && (
                <p className="mt-1 text-xs text-gray-400">
                  Includes a second VIP lane so everyone bowls together.
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">Plus applicable sales tax at checkout.</p>
            </div>
          )}

          {/* Card form */}
          {canPay && (
            <>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-200">
                <IconCreditCard className="h-4 w-4" style={{ color: accentColor }} /> Card details
              </p>
              <div
                id="sq-addon-card-container"
                className="mb-3 min-h-[50px] rounded-lg bg-white p-3"
              />
            </>
          )}

          {error && (
            <div className="mb-3 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-200 ring-1 ring-red-500/20">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setOpen(false)}
              className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-gray-300 hover:bg-white/5"
            >
              Cancel
            </button>
            {quote?.capacity.ok && (
              <button
                onClick={handlePay}
                disabled={paying || quoting}
                className="flex-1 rounded-xl px-6 py-3 text-base font-bold text-black disabled:opacity-50"
                style={{ backgroundColor: accentColor }}
              >
                {paying ? "Processing…" : `Add & pay ${fmt(quote.quote.totalCents)}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
