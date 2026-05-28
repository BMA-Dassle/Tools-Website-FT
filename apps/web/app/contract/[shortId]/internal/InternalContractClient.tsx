"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  IconBan, IconClock, IconShieldCheck, IconToolsKitchen2,
  IconStar, IconCreditCard, IconReceipt,
  IconCircleCheck, IconAlertTriangle, IconUsers, IconLink,
} from "@tabler/icons-react";

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images";

interface QuoteProps {
  id: number;
  contractShortId: string;
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

type Step = "review" | "tips" | "policy" | "sign" | "pay" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "review", label: "Review" },
  { key: "tips", label: "Event Info" },
  { key: "policy", label: "Policies" },
  { key: "sign", label: "Agree & Sign" },
  { key: "pay", label: "Deposit" },
];

export default function InternalContractClient({ quote }: { quote: QuoteProps }) {
  const [step, setStep] = useState<Step>(() => {
    if (quote.depositPaidAt) return "done";
    return "review";
  });
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [giftCardGan, setGiftCardGan] = useState(quote.giftCardGan);
  const [saveCard, setSaveCard] = useState(true);
  const cardRef = useRef<{
    tokenize: () => Promise<{ status: string; token?: string; errors?: Array<{ message: string }> }>;
    destroy: () => void;
  } | null>(null);
  const squareLoaded = useRef(false);

  // Signature state
  const [sigType, setSigType] = useState<"draw" | "type">("type");
  const [typedSig, setTypedSig] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawing = useRef(false);

  // Agreement checkboxes
  const [agreeDeposit, setAgreeDeposit] = useState(false);
  const [agreeNoPrepay, setAgreeNoPrepay] = useState(false);
  const [agreePaymentDay, setAgreePaymentDay] = useState(false);
  const [agreePolicies, setAgreePolicies] = useState(false);
  const [taxExempt, setTaxExempt] = useState<"yes" | "no" | null>(null);
  const [agreeUnderstand, setAgreeUnderstand] = useState(false);

  const allAgreed = agreeDeposit && agreeNoPrepay && agreePaymentDay && agreePolicies && taxExempt !== null && agreeUnderstand;

  // Compliance: capture IP + timestamp at sign time
  const [signedAt, setSignedAt] = useState<string | null>(null);

  // Load Square SDK
  useEffect(() => {
    if (step !== "pay" || squareLoaded.current) return;
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
        setError("Failed to load payment form. Please refresh.");
      }
    })();
    return () => { try { cardRef.current?.destroy(); } catch { /* */ } };
  }, [step, quote.squareLocationId]);

  // Canvas drawing handlers
  const startDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    isDrawing.current = true;
    const ctx = canvas.getContext("2d")!;
    const rect = canvas.getBoundingClientRect();
    const x = "touches" in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = "touches" in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, []);

  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const rect = canvas.getBoundingClientRect();
    const x = "touches" in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = "touches" in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#22d3ee";
    ctx.lineTo(x, y);
    ctx.stroke();
  }, []);

  const endDraw = useCallback(() => { isDrawing.current = false; }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const hasSig = sigType === "type" ? typedSig.trim().length > 2 : true;

  const handleSign = useCallback(() => {
    if (!allAgreed || !hasSig) return;
    setSignedAt(new Date().toISOString());
    setStep("pay");
  }, [allAgreed, hasSig]);

  const handlePay = useCallback(async () => {
    if (!cardRef.current) { setError("Payment form not ready."); return; }
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
        body: JSON.stringify({ contractShortId: quote.contractShortId, cardSourceId: result.token, saveCard }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || "Payment failed."); setProcessing(false); return; }
      setGiftCardGan(data.giftCardGan);
      setStep("done");
    } catch {
      setError("Payment processing failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  }, [quote.contractShortId, saveCard]);

  const fmtDollars = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  const stepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <Image src={`${BLOB}/hero/racer-journey-bg.webp`} alt="" fill className="object-cover" priority unoptimized />
          <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/80 via-[#000418]/60 to-[#000418]" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 pb-10 pt-36 text-center">
          {step === "done" ? (
            <>
              <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400">
                <svg className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="mb-2 text-4xl font-extrabold tracking-tight md:text-5xl">You&apos;re All Set!</h1>
              <p className="text-lg text-gray-300">Your adventure at {quote.centerName} is confirmed</p>
            </>
          ) : (
            <>
              <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-cyan-400">{quote.centerName}</p>
              <h1 className="mb-3 text-4xl font-extrabold tracking-tight md:text-5xl">
                {quote.guestFirstName}, your <span className="text-cyan-400">experience</span> awaits
              </h1>
            </>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#E53935] via-white/60 to-[#00E2E5]" />
      </div>

      {/* Step indicator */}
      {step !== "done" && (
        <div className="mx-auto max-w-3xl px-4 py-5">
          <div className="flex items-center justify-center gap-1">
            {STEPS.map((s, i) => {
              const isActive = s.key === step;
              const isPast = i < stepIdx;
              return (
                <div key={s.key} className="flex items-center gap-1">
                  {i > 0 && <div className={`h-px w-6 ${isPast ? "bg-cyan-400" : "bg-white/15"}`} />}
                  <div className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                    isActive ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40" :
                    isPast ? "bg-emerald-400/20 text-emerald-400" : "bg-white/5 text-gray-600"
                  }`}>
                    {isPast ? "✓" : ""} {s.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mx-auto max-w-4xl px-4 pb-16">
        {/* ═══ Step 1: Review ═══ */}
        {step === "review" && (
          <>
            {/* Event details card with racing image */}
            <div className="mb-8 overflow-hidden rounded-2xl border border-white/10 bg-[#071027]">
              <div className="grid md:grid-cols-[1fr_auto]">
                <div className="p-6">
                  <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">Event Details</h2>
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
                        <span className="text-gray-400">{item.name} <span className="text-gray-600">x{item.qty}</span></span>
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
                <div className="relative hidden w-64 md:block">
                  <Image src={`${BLOB}/attractions/DSC06577.webp`} alt="Racing" fill className="object-cover" unoptimized />
                  <div className="absolute inset-0 bg-gradient-to-r from-[#071027] to-transparent" />
                </div>
              </div>
            </div>

            {/* Payment schedule */}
            <div className="mb-8 rounded-2xl border border-white/10 bg-[#071027] p-5">
              <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">Payment Schedule</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-cyan-400/20 text-xs font-bold text-cyan-400 ring-1 ring-cyan-400/40">1</div>
                  <div className="flex-1">
                    <p className="font-semibold">50% Deposit — Due Today</p>
                    <p className="text-sm text-gray-400">Due upon signing your contract</p>
                  </div>
                  <p className="text-lg font-bold">{fmtDollars(quote.depositDueCents)}</p>
                </div>
                <div className="ml-4 h-6 border-l border-dashed border-white/20" />
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/5 text-xs font-bold text-gray-500">2</div>
                  <div className="flex-1">
                    <p className="font-semibold">Remaining Balance — 72 Hours Before Event</p>
                    <p className="text-sm text-gray-400">Automatically charged to your card on file</p>
                  </div>
                  <p className="text-lg font-bold">{fmtDollars(quote.balanceCents)}</p>
                </div>
              </div>
            </div>

            {/* Planner card with avatar + contact icons */}
            {quote.plannerFirst && (
              <div className="mb-8 rounded-2xl border border-white/10 bg-[#071027] p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-xl font-bold">
                    {quote.plannerFirst[0]}
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Your Event Planner</p>
                    <p className="text-lg font-bold">{quote.plannerFirst} {quote.plannerLast}</p>
                    <div className="mt-1 space-y-0.5 text-sm text-gray-400">
                      {quote.plannerPhone && <p><a href={`tel:${quote.plannerPhone}`} className="hover:text-cyan-400">{quote.plannerPhone}</a></p>}
                      {quote.plannerEmail && <p><a href={`mailto:${quote.plannerEmail}`} className="hover:text-cyan-400">{quote.plannerEmail}</a></p>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {quote.plannerPhone && (
                      <a href={`tel:${quote.plannerPhone}`} aria-label="Call planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-600 transition-colors hover:bg-cyan-500">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                        </svg>
                      </a>
                    )}
                    {quote.plannerPhone && (
                      <a href={`sms:${quote.plannerPhone}`} aria-label="Text planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      </a>
                    )}
                    {quote.plannerEmail && (
                      <a href={`mailto:${quote.plannerEmail}`} aria-label="Email planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                      </a>
                    )}
                  </div>
                </div>
                {quote.notes && (
                  <div className="mt-4 rounded-lg bg-white/5 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-500">Notes from your planner</p>
                    <p className="whitespace-pre-line text-sm text-gray-300">{quote.notes}</p>
                  </div>
                )}
              </div>
            )}

            <button onClick={() => setStep("tips")}
              className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-4 text-lg font-bold shadow-lg shadow-cyan-500/20">
              Continue
            </button>
          </>
        )}

        {/* ═══ Step 2: Helpful Tips ═══ */}
        {step === "tips" && (
          <>
            <div className="mb-6 rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-4 text-xl font-bold">Helpful Tips for Your Event</h2>
              <p className="mb-4 text-sm text-gray-300">We&apos;re excited to host your event! Here are a few reminders:</p>
              <div className="space-y-4">
                {[
                  { title: "Outside Food & Beverages", text: "No outside food or drinks. We welcome cakes for celebrations, but we’re unable to store them due to health guidelines.", Icon: IconBan },
                  { title: "Buffets", text: "Buffets are served for one hour and are for in-event dining only. No to-go food will be provided.", Icon: IconClock },
                  { title: "Waivers for Attractions", text: "For Laser Tag, Racing, and Nexus, all participants must complete a waiver. Your planner will provide a link — getting this done early avoids delays!", Icon: IconShieldCheck },
                  { title: "Adding Food", text: "If your quote doesn’t include food, you have up to 72 hours before the event to place your order.", Icon: IconToolsKitchen2 },
                  { title: "HeadPinz Rewards", text: "HeadPinz Rewards cannot be earned or redeemed on group events.", Icon: IconStar },
                  { title: "Payments", text: "A 50% deposit secures your event via our online system. Please bring payment on event day for the final balance. Splitting payments is not possible.", Icon: IconCreditCard },
                  { title: "Service Charge", text: "A mandatory, non-refundable service charge applies to all contracted events, including any additions on the day of.", Icon: IconReceipt },
                ].map((tip, i) => (
                  <div key={i} className="flex gap-4 rounded-xl bg-white/5 p-4">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-400/10">
                      <tip.Icon size={20} className="text-cyan-400" stroke={1.5} />
                    </div>
                    <div>
                      <p className="mb-1 font-semibold text-white">{tip.title}</p>
                      <p className="text-sm leading-relaxed text-gray-400">{tip.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep("review")} className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/5">Back</button>
              <button onClick={() => setStep("policy")}
                className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-3 text-lg font-bold shadow-lg shadow-cyan-500/20">
                Continue
              </button>
            </div>
          </>
        )}

        {/* ═══ Step 3: Cancellation Policy ═══ */}
        {step === "policy" && (
          <>
            <div className="mb-6 rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-4 text-xl font-bold">Cancellation Policy</h2>
              <div className="space-y-4">
                {[
                  { title: "More Than 7 Days' Notice", text: "Full deposit value can be applied toward rescheduling. The rescheduled event must meet or exceed the original value.", Icon: IconCircleCheck },
                  { title: "Within 7 Days of Event", text: "Cancellations are non-refundable. In some cases, you may be eligible for 50% of your deposit value.", Icon: IconAlertTriangle },
                  { title: "Guest Participants", text: "Changes must be made 3+ business days in advance. Guest count may increase but not decrease more than 15%. You'll be billed for the guaranteed count or actual attendance, whichever is higher.", Icon: IconUsers },
                  { title: "Additional Details", text: "Further details are governed by headpinz.com/GF-Policy", Icon: IconLink },
                ].map((item, i) => (
                  <div key={i} className="flex gap-4 rounded-xl bg-white/5 p-4">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-amber-400/10">
                      <item.Icon size={20} className="text-amber-400" stroke={1.5} />
                    </div>
                    <div>
                      <p className="mb-1 font-semibold text-white">{item.title}</p>
                      <p className="text-sm leading-relaxed text-gray-400">{item.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep("tips")} className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/5">Back</button>
              <button onClick={() => setStep("sign")}
                className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-3 text-lg font-bold shadow-lg shadow-cyan-500/20">
                Continue to Sign
              </button>
            </div>
          </>
        )}

        {/* ═══ Step 4: Agree & Sign ═══ */}
        {step === "sign" && (
          <>
            <div className="mb-6 rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-2 text-xl font-bold">Let&apos;s Make it Official</h2>
              <p className="mb-6 text-sm text-gray-400">
                We&apos;re excited to create lasting memories at {quote.centerName}! Confirm the details and sign below.
              </p>

              <div className="space-y-3">
                {[
                  { state: agreeDeposit, set: setAgreeDeposit, text: "I agree to make a 50% deposit via credit card after completing this document." },
                  { state: agreeNoPrepay, set: setAgreeNoPrepay, text: "I understand that we do not accept pre-paid payments and we are unable to collect final payment before your event." },
                  { state: agreePaymentDay, set: setAgreePaymentDay, text: "I'll have a form of payment ready on the day of my event." },
                  { state: agreePolicies, set: setAgreePolicies, text: "I agree to the \"Tips for Your Event\" and \"Cancellation\" policies." },
                ].map((item, i) => (
                  <label key={i} className="flex cursor-pointer items-start gap-3 rounded-lg bg-white/5 p-3">
                    <input type="checkbox" checked={item.state} onChange={(e) => item.set(e.target.checked)}
                      className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500" />
                    <span className="text-sm text-gray-300">{item.text}</span>
                  </label>
                ))}

                <div className="rounded-lg bg-white/5 p-3">
                  <p className="mb-2 text-sm text-gray-300">Are you tax exempt?</p>
                  <div className="flex gap-4">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="radio" name="tax" checked={taxExempt === "yes"} onChange={() => setTaxExempt("yes")}
                        className="h-4 w-4 text-cyan-500" />
                      <span className="text-sm">Yes</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="radio" name="tax" checked={taxExempt === "no"} onChange={() => setTaxExempt("no")}
                        className="h-4 w-4 text-cyan-500" />
                      <span className="text-sm">No</span>
                    </label>
                  </div>
                  {taxExempt === "yes" && (
                    <p className="mt-2 text-xs text-amber-400">Please email your DR-14 letter to your event planner.</p>
                  )}
                </div>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-white/5 p-3">
                  <input type="checkbox" checked={agreeUnderstand} onChange={(e) => setAgreeUnderstand(e.target.checked)}
                    className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500" />
                  <span className="text-sm text-gray-300">I understand that my tax exempt answer cannot be changed at the time of the event.</span>
                </label>
              </div>

              {/* Signature */}
              <div className="mt-6 border-t border-white/10 pt-6">
                <p className="mb-3 text-sm font-semibold text-gray-400">Guest Signature</p>
                <div className="mb-3 flex gap-2">
                  <button onClick={() => setSigType("type")}
                    className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${sigType === "type" ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40" : "bg-white/5 text-gray-500"}`}>
                    Type
                  </button>
                  <button onClick={() => setSigType("draw")}
                    className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${sigType === "draw" ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40" : "bg-white/5 text-gray-500"}`}>
                    Draw
                  </button>
                </div>

                {sigType === "type" ? (
                  <input
                    type="text"
                    value={typedSig}
                    onChange={(e) => setTypedSig(e.target.value)}
                    placeholder="Type your full name"
                    className="w-full rounded-lg border border-white/20 bg-[#0a1628] px-4 py-3 font-serif text-2xl italic text-cyan-300 placeholder:text-gray-600"
                  />
                ) : (
                  <div className="relative">
                    <canvas
                      ref={canvasRef}
                      width={500}
                      height={120}
                      onMouseDown={startDraw}
                      onMouseMove={draw}
                      onMouseUp={endDraw}
                      onMouseLeave={endDraw}
                      onTouchStart={startDraw}
                      onTouchMove={draw}
                      onTouchEnd={endDraw}
                      className="w-full cursor-crosshair rounded-lg border border-white/20 bg-[#0a1628]"
                    />
                    <button onClick={clearCanvas}
                      className="absolute right-2 top-2 rounded bg-white/10 px-2 py-0.5 text-xs text-gray-400 hover:bg-white/20">
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Compliance footer */}
              <p className="mt-4 text-[10px] text-gray-600">
                By signing, you consent to use electronic signatures per the ESIGN Act and UETA.
                Your signature, IP address, and timestamp will be recorded for verification purposes.
              </p>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep("policy")} className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/5">Back</button>
              <button onClick={handleSign} disabled={!allAgreed || !hasSig}
                className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-4 text-lg font-bold shadow-lg shadow-cyan-500/20 disabled:opacity-40">
                Sign & Continue to Payment
              </button>
            </div>
          </>
        )}

        {/* ═══ Step 5: Pay Deposit ═══ */}
        {step === "pay" && (
          <>
            <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-500/10 px-4 py-3 ring-1 ring-emerald-500/20">
              <svg className="h-5 w-5 flex-shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <p className="font-semibold text-emerald-300">
                Contract signed{signedAt ? ` at ${new Date(signedAt).toLocaleTimeString()}` : ""}! Now secure your date.
              </p>
            </div>

            <div className="mb-6 rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-1 text-xl font-bold">Secure Your Event</h2>
              <p className="mb-6 text-sm text-gray-400">
                Deposit: <span className="font-semibold text-white">{fmtDollars(quote.depositDueCents)}</span>
                {quote.balanceCents > 0 && ` — remaining ${fmtDollars(quote.balanceCents)} charged 72 hours before event.`}
              </p>

              <div id="sq-card-container" className="mb-4 min-h-[50px] rounded-lg bg-white p-3" />

              <label className="mb-5 flex cursor-pointer items-center gap-2.5 text-sm text-gray-300">
                <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800" />
                Save card for remaining balance
              </label>

              {error && (
                <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-200 ring-1 ring-red-500/20">{error}</div>
              )}

              <button onClick={handlePay} disabled={processing}
                className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-cyan-500/20 disabled:opacity-50">
                {processing ? "Processing..." : `Pay ${fmtDollars(quote.depositDueCents)} Deposit`}
              </button>
            </div>
          </>
        )}

        {/* ═══ Step 6: Done ═══ */}
        {step === "done" && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-8 text-center">
              <p className="mb-2 text-lg font-semibold text-emerald-300">Deposit Confirmed</p>
              <p className="text-3xl font-extrabold">{fmtDollars(quote.depositDueCents)}</p>
              {giftCardGan && <p className="mt-2 font-mono text-sm text-cyan-400">Ref: {giftCardGan}</p>}
            </div>
            <p className="text-center text-gray-400">Your planner will be in touch with final details. See you at {quote.centerName}!</p>
          </div>
        )}

        {/* Prototype badge */}
        <div className="mt-8 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-center text-xs text-amber-400">
          INTERNAL PROTOTYPE — This is an exploration of replacing PandaDoc with a custom signing flow.
          Compliance features (IP logging, audit trail, PDF generation) are scaffolded but not production-ready.
        </div>
      </div>
    </div>
  );
}
