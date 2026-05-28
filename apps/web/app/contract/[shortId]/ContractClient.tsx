"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";

// Square types are declared globally in components/square/PaymentForm.tsx

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images";

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
  const [signingReady, setSigningReady] = useState(false);
  const signingInitiated = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signingRef = useRef<any>(null);
  const [schedule, setSchedule] = useState<Array<{
    activity: string;
    count: number;
    start: string;
    end: string;
    persons: number;
  }> | null>(null);

  // Fetch event schedule from BMI Office
  useEffect(() => {
    fetch(`/api/group-function/schedule?shortId=${quote.contractShortId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.schedule?.length > 0) setSchedule(data.schedule);
      })
      .catch(() => {});
  }, [quote.contractShortId]);

  useEffect(() => {
    if (phase !== "sign" || signingReady || signingInitiated.current) return;
    signingInitiated.current = true;

    (async () => {
      try {
        const res = await fetch(
          `/api/group-function/signing-session?shortId=${quote.contractShortId}`,
        );
        const data = await res.json();
        if (!data.sessionId) {
          setError(data.error || "Failed to load signing session");
          return;
        }

        const { Signing } = await import("pandadoc-signing");
        const signing = new Signing(
          "pandadoc-signing-container",
          { sessionId: data.sessionId, width: "100%", height: 700 },
          { region: "com" },
        );

        signing.on("document.completed", () => setPhase("pay"));
        signing.on("document.loaded", () => setSigningReady(true));
        signing.on("document.exception", () =>
          setError("Something went wrong loading the contract. Please refresh."),
        );

        await signing.open();
        signingRef.current = signing;
      } catch {
        setError("Failed to load contract. Please refresh.");
      }
    })();
  }, [phase, signingReady, quote.contractShortId]);

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
      } catch {
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

  // PandaDoc events are handled by the Signing library above

  const handlePay = useCallback(async () => {
    if (!cardRef.current) {
      setError("Payment form not ready.");
      return;
    }
    setError(null);
    setProcessing(true);
    try {
      const result = await cardRef.current.tokenize();
      if (result.status !== "OK" || !result.token) {
        setError(result.errors?.[0]?.message || "Card validation failed.");
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
        setError(data.error || "Payment failed.");
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

  const isFT = quote.brand === "fasttrax";

  return (
    <div className="min-h-screen">
      {/* ─── Hero Section ─── */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <Image
            src={`${BLOB}/subpages/group-events-hero.webp`}
            alt=""
            fill
            className="object-cover"
            priority
            unoptimized
          />
          <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/80 via-[#000418]/60 to-[#000418]" />
        </div>

        <div className="relative mx-auto max-w-4xl px-4 pb-12 pt-36 text-center">
          {phase === "done" ? (
            <>
              <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400">
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
              <h1 className="mb-2 text-4xl font-extrabold tracking-tight md:text-5xl">
                You&apos;re All Set!
              </h1>
              <p className="text-lg text-gray-300">
                Your adventure at {quote.centerName} is confirmed
              </p>
            </>
          ) : (
            <>
              <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-cyan-400">
                {quote.centerName}
              </p>
              <h1 className="mb-3 text-4xl font-extrabold tracking-tight md:text-5xl">
                {quote.guestFirstName}, your
                <span className={isFT ? " text-cyan-400" : " text-rose-400"}> experience </span>
                awaits
              </h1>
              <p className="mx-auto max-w-xl text-lg text-gray-300">
                Review your event details below, sign your contract, and secure your date with a
                deposit.
              </p>
            </>
          )}
        </div>

        {/* Gradient bottom border */}
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#E53935] via-white/60 to-[#00E2E5]" />
      </div>

      {/* ─── Steps indicator ─── */}
      {phase !== "done" && (
        <div className="mx-auto max-w-2xl px-4 py-6">
          <div className="flex items-center justify-center gap-2 text-sm">
            {[
              { label: "Review & Sign", step: "sign" },
              { label: "Pay Deposit", step: "pay" },
              { label: "Confirmed", step: "done" },
            ].map((s, i) => {
              const isActive = s.step === phase;
              const isPast = (phase === "pay" && s.step === "sign") || (phase as string) === "done";
              return (
                <div key={s.step} className="flex items-center gap-2">
                  {i > 0 && (
                    <div className={`h-px w-8 ${isPast ? "bg-cyan-400" : "bg-white/20"}`} />
                  )}
                  <div
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                      isActive
                        ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40"
                        : isPast
                          ? "bg-emerald-400/20 text-emerald-400"
                          : "bg-white/5 text-gray-500"
                    }`}
                  >
                    {isPast ? (
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <span>{i + 1}</span>
                    )}
                    {s.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mx-auto max-w-4xl px-4 pb-16">
        {/* ─── Event Details Card ─── */}
        <div className="mb-8 overflow-hidden rounded-2xl border border-white/10 bg-[#071027]">
          <div className="grid md:grid-cols-[1fr_auto]">
            <div className="p-6">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
                Event Details
              </h2>
              <h3 className="mb-4 text-2xl font-bold">{quote.eventName}</h3>
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-gray-500">Date & Time</p>
                  <p className="font-semibold">{quote.eventDateDisplay}</p>
                </div>
                {quote.guestCount && (
                  <div>
                    <p className="text-xs text-gray-500">Guests</p>
                    <p className="font-semibold">{quote.guestCount}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-gray-500">Total</p>
                  <p className="text-xl font-bold text-white">{fmtDollars(quote.totalCents)}</p>
                </div>
              </div>

              <div className="space-y-1.5 border-t border-white/10 pt-3">
                {quote.lineItems.map((item, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-400">
                      {item.name} <span className="text-gray-600">x{item.qty}</span>
                    </span>
                    <span className="font-medium">{fmtDollars(Math.round(item.total * 100))}</span>
                  </div>
                ))}
                {quote.taxCents > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Tax</span>
                    <span className="font-medium">{fmtDollars(quote.taxCents)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-white/10 pt-2 text-sm font-bold">
                  <span>Total</span>
                  <span>{fmtDollars(quote.totalCents)}</span>
                </div>
              </div>
            </div>

            {/* Activity preview image */}
            <div className="relative hidden w-64 md:block">
              <Image
                src={`${BLOB}/attractions/DSC06577.webp`}
                alt="Racing experience"
                fill
                className="object-cover"
                unoptimized
              />
              <div className="absolute inset-0 bg-gradient-to-r from-[#071027] to-transparent" />
            </div>
          </div>
        </div>

        {/* ─── Event Schedule Timeline ─── */}
        {schedule && schedule.length > 0 && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-[#071027] p-5">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
              Event Schedule
            </h3>
            <div className="relative space-y-0">
              {schedule.map((s, i) => (
                <div key={i} className="flex gap-4">
                  {/* Timeline line + dot */}
                  <div className="flex flex-col items-center">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-cyan-400/20 text-xs font-bold text-cyan-400 ring-1 ring-cyan-400/30">
                      {s.start.replace(/:00\s/, " ").replace(/\s/g, "")}
                    </div>
                    {i < schedule.length - 1 && (
                      <div className="my-1 h-8 w-px bg-gradient-to-b from-cyan-400/40 to-transparent" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="flex-1 pb-4">
                    <p className="font-semibold">{s.activity}</p>
                    <p className="text-sm text-gray-400">
                      {s.start} – {s.end}
                      {s.count > 1 && (
                        <span className="ml-2 text-gray-500">
                          ({s.count} {s.activity.toLowerCase().includes("lane") ? "lanes" : "areas"}
                          )
                        </span>
                      )}
                      {s.persons > 0 && (
                        <span className="ml-2 text-gray-500">{s.persons} guests</span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Planner Card ─── */}
        {quote.plannerFirst && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-[#071027] p-5">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-xl font-bold">
                {quote.plannerFirst[0]}
              </div>
              <div className="flex-1">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                  Your Event Planner
                </p>
                <p className="text-lg font-bold">
                  {quote.plannerFirst} {quote.plannerLast}
                </p>
                <div className="mt-1 space-y-0.5 text-sm text-gray-400">
                  {quote.plannerPhone && (
                    <p>
                      <a href={`tel:${quote.plannerPhone}`} className="hover:text-cyan-400">
                        {quote.plannerPhone}
                      </a>
                    </p>
                  )}
                  {quote.plannerEmail && (
                    <p>
                      <a href={`mailto:${quote.plannerEmail}`} className="hover:text-cyan-400">
                        {quote.plannerEmail}
                      </a>
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {quote.plannerPhone && (
                  <a
                    href={`tel:${quote.plannerPhone}`}
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-600 transition-colors hover:bg-cyan-500"
                    title="Call"
                    aria-label="Call planner"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                      />
                    </svg>
                  </a>
                )}
                {quote.plannerPhone && (
                  <a
                    href={`sms:${quote.plannerPhone}`}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
                    title="Text"
                    aria-label="Text planner"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                  </a>
                )}
                {quote.plannerEmail && (
                  <a
                    href={`mailto:${quote.plannerEmail}`}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
                    title="Email"
                    aria-label="Email planner"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            {quote.notes && (
              <div className="mt-4 rounded-lg bg-white/5 p-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-500">
                  Notes from your planner
                </p>
                <p className="whitespace-pre-line text-sm text-gray-300">{quote.notes}</p>
              </div>
            )}
          </div>
        )}

        {/* ─── Payment Schedule ─── */}
        {phase !== "done" && quote.depositDueCents > 0 && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-[#071027] p-5">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
              Payment Schedule
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    phase === "sign"
                      ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40"
                      : "bg-emerald-400/20 text-emerald-400"
                  }`}
                >
                  {phase === "sign" ? (
                    "1"
                  ) : (
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div className="flex-1">
                  <p className="font-semibold">50% Deposit — Due Today</p>
                  <p className="text-sm text-gray-400">Due upon signing your contract</p>
                </div>
                <p className="text-lg font-bold">{fmtDollars(quote.depositDueCents)}</p>
              </div>
              <div className="ml-4 h-6 border-l border-dashed border-white/20" />
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/5 text-xs font-bold text-gray-500">
                  2
                </div>
                <div className="flex-1">
                  <p className="font-semibold">Remaining Balance — 72 Hours Before Event</p>
                  <p className="text-sm text-gray-400">
                    Automatically charged to your card on file
                  </p>
                </div>
                <p className="text-lg font-bold">{fmtDollars(quote.balanceCents)}</p>
              </div>
            </div>
          </div>
        )}

        {/* ─── Phase A: Sign ─── */}
        {phase === "sign" && (
          <div className="mb-8">
            <h2 className="mb-4 text-xl font-bold">Review & Sign Your Contract</h2>
            {!signingReady && !error && signingInitiated.current && (
              <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-[#071027] p-16">
                <div className="flex flex-col items-center gap-3">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                  <p className="text-gray-400">Loading your contract...</p>
                </div>
              </div>
            )}
            <div
              id="pandadoc-signing-container"
              className="overflow-hidden rounded-2xl border border-white/10"
            />
            {!signingReady && error && (
              <div className="rounded-2xl border border-red-500/20 bg-red-900/20 p-8 text-center">
                <p className="text-red-300">{error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    signingInitiated.current = false;
                  }}
                  className="mt-3 rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
                >
                  Retry
                </button>
              </div>
            )}
            <p className="mt-3 text-center text-xs text-gray-500">
              After signing, you&apos;ll be prompted to secure your date with a deposit.
            </p>
          </div>
        )}

        {/* ─── Phase B: Pay ─── */}
        {phase === "pay" && (
          <div className="mb-8">
            <div className="mb-6 flex items-center gap-3 rounded-xl bg-emerald-500/10 px-4 py-3 ring-1 ring-emerald-500/20">
              <svg
                className="h-5 w-5 flex-shrink-0 text-emerald-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <p className="font-semibold text-emerald-300">
                Contract signed! Now let&apos;s secure your date.
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-1 text-xl font-bold">Secure Your Event</h2>
              <p className="mb-6 text-sm text-gray-400">
                A deposit of{" "}
                <span className="font-semibold text-white">
                  {fmtDollars(quote.depositDueCents)}
                </span>{" "}
                secures your date.{" "}
                {quote.balanceCents > 0 &&
                  `The remaining ${fmtDollars(quote.balanceCents)} will be charged 72 hours before your event.`}
              </p>

              <div id="sq-card-container" className="mb-4 min-h-[50px] rounded-lg bg-white p-3" />

              <label className="mb-5 flex cursor-pointer items-center gap-2.5 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={saveCard}
                  onChange={(e) => setSaveCard(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800"
                />
                Save card for remaining balance
              </label>

              {error && (
                <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-200 ring-1 ring-red-500/20">
                  {error}
                </div>
              )}

              <button
                onClick={handlePay}
                disabled={processing}
                className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-cyan-500/20 transition-all hover:shadow-cyan-500/30 disabled:opacity-50"
              >
                {processing ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Processing...
                  </span>
                ) : (
                  `Pay ${fmtDollars(quote.depositDueCents)} Deposit`
                )}
              </button>
            </div>
          </div>
        )}

        {/* ─── Phase C: Done ─── */}
        {phase === "done" && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-8 text-center">
              <p className="mb-2 text-lg font-semibold text-emerald-300">Deposit Confirmed</p>
              <p className="text-3xl font-extrabold">{fmtDollars(quote.depositDueCents)}</p>
              {giftCardGan && (
                <p className="mt-2 font-mono text-sm text-cyan-400">Ref: {giftCardGan}</p>
              )}
            </div>

            <EventCountdown eventDate={quote.eventDate} centerName={quote.centerName} />

            {/* What to expect */}
            <div>
              <h3 className="mb-4 text-center text-lg font-bold">What to Expect</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  {
                    img: `${BLOB}/attractions/DSC06577.webp`,
                    title: "Arrive & Check In",
                    desc: "Our team will greet your group and get everyone set up.",
                  },
                  {
                    img: `${BLOB}/attractions/DSC06538.webp`,
                    title: "Play & Compete",
                    desc: "Racing, laser tag, bowling, arcade — your custom package.",
                  },
                  {
                    img: `${BLOB}/attractions/DSC06481.webp`,
                    title: "Eat & Celebrate",
                    desc: "Food and drinks served trackside at Nemo's.",
                  },
                ].map((step, i) => (
                  <div
                    key={i}
                    className="overflow-hidden rounded-xl border border-white/10 bg-[#071027]"
                  >
                    <div className="relative h-36">
                      <Image
                        src={step.img}
                        alt={step.title}
                        fill
                        className="object-cover"
                        unoptimized
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#071027] to-transparent" />
                      <span className="absolute bottom-2 left-3 text-xs font-bold text-cyan-400">
                        Step {i + 1}
                      </span>
                    </div>
                    <div className="p-3">
                      <p className="font-semibold">{step.title}</p>
                      <p className="text-xs text-gray-400">{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap justify-center gap-3">
              <a
                href={`data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(quote))}`}
                download={`${quote.eventName || "Event"}.ics`}
                className="rounded-full bg-white/10 px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-white/20"
              >
                Add to Calendar
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EventCountdown({ eventDate, centerName }: { eventDate: string; centerName: string }) {
  const [diff, setDiff] = useState<{ days: number; hours: number; mins: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const ms = new Date(eventDate).getTime() - Date.now();
      if (ms <= 0) {
        setDiff(null);
        return;
      }
      setDiff({
        days: Math.floor(ms / 86_400_000),
        hours: Math.floor((ms % 86_400_000) / 3_600_000),
        mins: Math.floor((ms % 3_600_000) / 60_000),
      });
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [eventDate]);

  if (!diff) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#071027] p-6 text-center">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-400">
        Countdown to {centerName}
      </p>
      <div className="flex justify-center gap-4">
        {[
          { value: diff.days, label: "Days" },
          { value: diff.hours, label: "Hours" },
          { value: diff.mins, label: "Minutes" },
        ].map((unit) => (
          <div key={unit.label}>
            <p className="text-4xl font-extrabold tabular-nums text-cyan-400">{unit.value}</p>
            <p className="text-xs text-gray-500">{unit.label}</p>
          </div>
        ))}
      </div>
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
