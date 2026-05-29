"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  IconBan,
  IconClock,
  IconShieldCheck,
  IconToolsKitchen2,
  IconStar,
  IconCreditCard,
  IconReceipt,
  IconCircleCheck,
  IconAlertTriangle,
  IconUsers,
  IconClipboardCheck,
  IconCalendarEvent,
  IconShare,
  IconLink,
} from "@tabler/icons-react";
import { useVisibleInterval } from "@/lib/use-visible-interval";

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
  status: string;
  isTaxExempt: boolean;
}

type Step = "review" | "tips" | "policy" | "sign" | "pay" | "done" | "event";
const STEPS: { key: Step; label: string; short: string }[] = [
  { key: "review", label: "Review", short: "Review" },
  { key: "tips", label: "Event Info", short: "Info" },
  { key: "policy", label: "Policies", short: "Policy" },
  { key: "sign", label: "Agree & Sign", short: "Sign" },
  { key: "pay", label: "Deposit", short: "Pay" },
];

export default function ContractClient({ quote }: { quote: QuoteProps }) {
  if (quote.status === "cancelled" || quote.status === "denied") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full bg-red-500/10">
          <IconBan size={40} className="text-red-400" />
        </div>
        <h1 className="mb-2 text-2xl font-bold">
          Event {quote.status === "cancelled" ? "Cancelled" : "Denied"}
        </h1>
        <p className="text-gray-400">
          {quote.status === "cancelled"
            ? "This event has been cancelled. If you believe this is an error, please contact your event planner."
            : "This event contract has been denied. Please contact your event planner for details."}
        </p>
        {quote.plannerFirst && (
          <div className="mt-8 inline-block rounded-2xl border border-white/10 bg-[#071027] px-8 py-5 text-left">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              Your Event Planner
            </p>
            <p className="mt-1 font-bold">
              {quote.plannerFirst} {quote.plannerLast}
            </p>
            {quote.plannerPhone && (
              <p className="mt-0.5 text-sm text-gray-400">
                <a href={`tel:${quote.plannerPhone}`} className="hover:text-cyan-400">
                  {quote.plannerPhone}
                </a>
              </p>
            )}
            {quote.plannerEmail && (
              <p className="text-sm text-gray-400">
                <a href={`mailto:${quote.plannerEmail}`} className="hover:text-cyan-400">
                  {quote.plannerEmail}
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  const [step, setStep] = useState<Step>(() => {
    if (quote.status === "resign_required") return "review";
    if (quote.depositPaidAt) return "event";
    return "review";
  });
  const alreadyPaid = Boolean(quote.depositPaidAt);

  // Show banner if returning from a resign_required state
  const [updateBannerInit] = useState(() =>
    quote.status === "resign_required"
      ? "Your event has been updated and requires re-confirmation"
      : null,
  );
  const [updateBanner, setUpdateBanner] = useState<string | null>(updateBannerInit);
  const [signedPdfUrl, setSignedPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [giftCardGan, setGiftCardGan] = useState(quote.giftCardGan);
  const [saveCard, setSaveCard] = useState(true);
  const cardRef = useRef<{
    tokenize: () => Promise<{
      status: string;
      token?: string;
      errors?: Array<{ message: string }>;
    }>;
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
  const [taxExempt, setTaxExempt] = useState<"yes" | "no" | null>(quote.isTaxExempt ? "yes" : null);
  const [agreeUnderstand, setAgreeUnderstand] = useState(false);

  // Page-level acknowledgments
  const [waiverAcknowledged, setWaiverAcknowledged] = useState(false);
  const [tipsAcknowledged, setTipsAcknowledged] = useState(false);
  const [policyAcknowledged, setPolicyAcknowledged] = useState(false);

  // Tax exempt file upload
  const [taxFile, setTaxFile] = useState<File | null>(null);
  const [taxFileUrl, setTaxFileUrl] = useState<string | null>(null);
  const [taxUploading, setTaxUploading] = useState(false);

  const taxValid = taxExempt === "no" || (taxExempt === "yes" && Boolean(taxFileUrl));
  const allAgreed =
    agreeDeposit && agreeNoPrepay && taxExempt !== null && taxValid && agreeUnderstand;

  // Compliance: capture IP + timestamp at sign time
  const [signedAt, setSignedAt] = useState<string | null>(null);

  // Scroll to top on step change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  // Event details for the post-deposit event page
  const [eventDetails, setEventDetails] = useState<{
    notes: string;
    waiverUrl: string | null;
    participants: Array<{ name: string; confirmed: boolean; confirmedAt: string | null }>;
    totalParticipants: number;
    confirmedCount: number;
  } | null>(null);

  // Live polling for quote changes + event details
  const lastHash = useRef<string | null>(null);
  useVisibleInterval(async (signal) => {
    try {
      // Poll quote status for changes
      const statusRes = await fetch(
        `/api/group-function/quote-status?shortId=${quote.contractShortId}`,
        { signal, cache: "no-store" },
      );
      if (signal.aborted || !statusRes.ok) return;
      const statusData = await statusRes.json();

      // Detect changes — reload page to get fresh server data
      if (lastHash.current && lastHash.current !== statusData.lineItemsHash) {
        window.location.reload();
        return;
      }
      // Detect resign_required status change
      if (statusData.status === "resign_required" && step === "event") {
        window.location.reload();
        return;
      }
      if (statusData.status === "cancelled" || statusData.status === "denied") {
        window.location.reload();
        return;
      }
      lastHash.current = statusData.lineItemsHash;
      if (statusData.signedPdfUrl && !signedPdfUrl) setSignedPdfUrl(statusData.signedPdfUrl);

      // Fetch event details if on event page
      if (step === "event") {
        const detailsRes = await fetch(
          `/api/group-function/event-details?shortId=${quote.contractShortId}`,
          { signal, cache: "no-store" },
        );
        if (!signal.aborted && detailsRes.ok) {
          setEventDetails(await detailsRes.json());
        }
      }
    } catch {
      /* network error, retry next cycle */
    }
  }, 15_000);

  // Fetch event details on mount (live notes for review + full details for event page)
  useEffect(() => {
    fetch(`/api/group-function/event-details?shortId=${quote.contractShortId}`)
      .then((r) => r.json())
      .then((d) => setEventDetails(d))
      .catch(() => {});
  }, [quote.contractShortId]);

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
    return () => {
      try {
        cardRef.current?.destroy();
      } catch {
        /* */
      }
    };
  }, [step, quote.squareLocationId]);

  // Canvas drawing handlers
  const getCanvasCoords = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }, []);

  const startDraw = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if ("touches" in e) e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      isDrawing.current = true;
      const ctx = canvas.getContext("2d")!;
      const { x, y } = getCanvasCoords(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    },
    [getCanvasCoords],
  );

  const draw = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if ("touches" in e) e.preventDefault();
      if (!isDrawing.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;
      const { x, y } = getCanvasCoords(e);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#22d3ee";
      ctx.lineTo(x, y);
      ctx.stroke();
    },
    [getCanvasCoords],
  );

  const endDraw = useCallback(() => {
    isDrawing.current = false;
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const hasSig = sigType === "type" ? typedSig.trim().length > 2 : true;

  const handleSign = useCallback(async () => {
    if (!allAgreed || !hasSig) return;
    setProcessing(true);
    try {
      const sigValue =
        sigType === "type" ? typedSig : canvasRef.current?.toDataURL("image/png") || "";
      const res = await fetch("/api/group-function/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: quote.contractShortId,
          signatureType: sigType,
          signatureData: sigValue,
          agreements: {
            deposit: agreeDeposit,
            autoCharge: agreeNoPrepay,
            waiverAcknowledged,
            tipsAcknowledged,
            policyAcknowledged,
          },
          taxExempt: taxExempt || "no",
          taxFileUrl: taxFileUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Failed to record signature");
        setProcessing(false);
        return;
      }
      setSignedAt(data.signedAt);
      // If already paid (resign flow), skip payment and go to event page
      if (alreadyPaid) {
        fetch("/api/group-function/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shortId: quote.contractShortId, event: "re-signed" }),
        }).catch(() => {});
        // Regenerate signed PDF with updated data
        fetch("/api/group-function/generate-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shortId: quote.contractShortId }),
        }).catch(() => {});
        setUpdateBanner(null);
        setStep("event");
      } else {
        setStep("pay");
      }
    } catch {
      setError("Failed to record signature. Please try again.");
    } finally {
      setProcessing(false);
    }
  }, [
    allAgreed,
    hasSig,
    sigType,
    typedSig,
    quote.contractShortId,
    agreeDeposit,
    agreeNoPrepay,
    waiverAcknowledged,
    tipsAcknowledged,
    policyAcknowledged,
    taxExempt,
    taxFileUrl,
  ]);

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
      setStep("event");
      // Generate signed PDF in background (non-blocking)
      fetch("/api/group-function/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId: quote.contractShortId }),
      }).catch(() => {});
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
    <div className="min-h-screen relative overflow-hidden">
      {/* Ambient background glows */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-40 -left-40 h-[500px] w-[500px] rounded-full bg-[#E53935]/8 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 h-[600px] w-[600px] rounded-full bg-[#00E2E5]/6 blur-[150px]" />
        <div className="absolute bottom-1/4 left-1/4 h-[400px] w-[400px] rounded-full bg-[#9b51e0]/5 blur-[120px]" />
      </div>

      {/* Hero */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <Image
            src={`${BLOB}/hero/racer-journey-bg.webp`}
            alt=""
            fill
            className="object-cover"
            priority
            unoptimized
          />
          <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/80 via-[#000418]/60 to-[#000418]" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 pb-10 pt-36 text-center">
          {step === "event" ? (
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
                {quote.guestFirstName}, your <span className="text-cyan-400">experience</span>{" "}
                awaits
              </h1>
            </>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#E53935] via-white/60 to-[#00E2E5]" />
      </div>

      {/* Update banner */}
      {updateBanner && (
        <div className="mx-auto max-w-4xl px-4 pt-4">
          <div className="flex items-center gap-3 rounded-xl bg-amber-500/10 px-4 py-3 ring-1 ring-amber-500/20">
            <IconAlertTriangle size={20} className="flex-shrink-0 text-amber-400" />
            <p className="flex-1 text-sm font-semibold text-amber-300">{updateBanner}</p>
            <button
              onClick={() => setUpdateBanner(null)}
              className="text-amber-400 hover:text-amber-300"
              aria-label="Dismiss"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Step indicator */}
      {step !== "done" && step !== "event" && (
        <div className="mx-auto max-w-3xl px-4 py-5">
          <div className="flex items-center justify-center gap-1">
            {STEPS.map((s, i) => {
              const isActive = s.key === step;
              const isPast = i < stepIdx;
              return (
                <div key={s.key} className="flex items-center gap-1">
                  {i > 0 && (
                    <div className={`h-px w-4 sm:w-6 ${isPast ? "bg-cyan-400" : "bg-white/15"}`} />
                  )}
                  <div
                    className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[9px] sm:px-2.5 sm:text-[10px] font-semibold ${
                      isActive
                        ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40"
                        : isPast
                          ? "bg-emerald-400/20 text-emerald-400"
                          : "bg-white/5 text-gray-600"
                    }`}
                  >
                    {isPast ? "✓ " : ""}
                    <span className="hidden sm:inline">{s.label}</span>
                    <span className="sm:hidden">{s.short}</span>
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
                        <span className="font-medium">
                          {fmtDollars(Math.round(item.total * 100))}
                        </span>
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

                  {/* Planner notes — live from BMI Office, fallback to DB */}
                  {(quote.notes || eventDetails?.notes) && (
                    <div className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-cyan-400">
                        Notes from {quote.plannerFirst || "Your Planner"}
                      </p>
                      <p className="whitespace-pre-line text-sm leading-relaxed text-gray-300">
                        {eventDetails?.notes || quote.notes}
                      </p>
                    </div>
                  )}
                </div>
                <div className="relative hidden w-64 md:block">
                  <Image
                    src={`${BLOB}/attractions/DSC06577.webp`}
                    alt="Racing"
                    fill
                    className="object-cover"
                    unoptimized
                  />
                  <div className="absolute inset-0 bg-gradient-to-r from-[#071027] to-transparent" />
                </div>
              </div>
            </div>

            {/* Payment schedule */}
            <div className="mb-8 rounded-2xl border border-white/10 bg-[#071027] p-5">
              <h3 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
                Payment Schedule
              </h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-cyan-400/20 text-xs font-bold text-cyan-400 ring-1 ring-cyan-400/40">
                    1
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

            {/* Planner card with avatar + contact icons */}
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
                        aria-label="Call planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-600 transition-colors hover:bg-cyan-500"
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
                        aria-label="Text planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
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
                        aria-label="Email planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
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
              </div>
            )}

            <button
              onClick={() => setStep("tips")}
              className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-4 text-lg font-bold shadow-lg shadow-cyan-500/20"
            >
              Continue
            </button>
          </>
        )}

        {/* ═══ Step 2: Helpful Tips ═══ */}
        {step === "tips" && (
          <>
            <div className="mb-6 rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-4 text-xl font-bold">Helpful Tips for Your Event</h2>
              <p className="mb-4 text-sm text-gray-300">
                We&apos;re excited to host your event! Here are a few reminders:
              </p>
              <div className="space-y-4">
                {[
                  {
                    title: "Outside Food & Beverages",
                    text: "No outside food or drinks. We welcome cakes for celebrations, but we’re unable to store them due to health guidelines.",
                    Icon: IconBan,
                  },
                  {
                    title: "Buffets",
                    text: "Buffets are served for one hour and are for in-event dining only. No to-go food will be provided.",
                    Icon: IconClock,
                  },
                  {
                    title: "Adding Food",
                    text: "If your quote doesn’t include food, you have up to 72 hours before the event to place your order.",
                    Icon: IconToolsKitchen2,
                  },
                  {
                    title: "HeadPinz Rewards",
                    text: "HeadPinz Rewards cannot be earned or redeemed on group events.",
                    Icon: IconStar,
                  },
                  {
                    title: "Payments",
                    text: "A 50% deposit secures your event via our online system. The remaining balance is charged 72 hours before your event.",
                    Icon: IconCreditCard,
                  },
                  {
                    title: "Service Charge",
                    text: "A mandatory, non-refundable service charge applies to all contracted events, including any additions on the day of.",
                    Icon: IconReceipt,
                  },
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

                {/* Waivers — mandatory acknowledgment */}
                <div
                  className={`rounded-xl p-4 transition-colors ${waiverAcknowledged ? "bg-emerald-400/5 ring-1 ring-emerald-400/20" : "bg-red-500/5 ring-1 ring-red-500/20"}`}
                >
                  <div className="flex gap-4">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-red-500/10">
                      <IconShieldCheck size={20} className="text-red-400" stroke={1.5} />
                    </div>
                    <div className="flex-1">
                      <p className="mb-1 font-semibold text-white">Waivers for Attractions</p>
                      <p className="text-sm leading-relaxed text-gray-400">
                        For Laser Tag, Racing, and Nexus, all participants must complete a waiver.
                        Your planner will provide a link — getting this done early avoids delays!
                      </p>
                      <p className="mt-2 text-xs font-semibold text-red-400">
                        MANDATORY: Failure to complete waivers prior to your event is grounds for
                        cancellation.
                      </p>
                    </div>
                  </div>
                  <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-lg bg-white/5 p-3">
                    <input
                      type="checkbox"
                      checked={waiverAcknowledged}
                      onChange={(e) => setWaiverAcknowledged(e.target.checked)}
                      className="h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500"
                    />
                    <span className="text-sm font-semibold text-white">
                      I understand that waivers are required for all participants
                    </span>
                  </label>
                </div>
              </div>
            </div>

            {/* Acknowledge event info */}
            <label className="mb-4 flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-[#071027] p-5">
              <input
                type="checkbox"
                checked={tipsAcknowledged}
                onChange={(e) => setTipsAcknowledged(e.target.checked)}
                className="h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500"
              />
              <span className="text-sm font-semibold text-white">
                I have read and understand the event information above
              </span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setStep("review")}
                className="rounded-xl border border-white/20 py-4 font-semibold hover:bg-white/5"
              >
                Back
              </button>
              <button
                onClick={() => setStep("policy")}
                disabled={!waiverAcknowledged || !tipsAcknowledged}
                className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-4 text-lg font-bold shadow-lg shadow-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
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
                  {
                    title: "More Than 7 Days' Notice",
                    text: "Full deposit value can be applied toward rescheduling. The rescheduled event must meet or exceed the original value.",
                    Icon: IconCircleCheck,
                  },
                  {
                    title: "Within 7 Days of Event",
                    text: "Cancellations are non-refundable. In some cases, you may be eligible for 50% of your deposit value.",
                    Icon: IconAlertTriangle,
                  },
                  {
                    title: "Guest Participants",
                    text: "Guest count may be updated more than 72 hours before your event. Headcount may increase but not decrease more than 15%. You'll be billed for the guaranteed count or actual attendance, whichever is higher.",
                    Icon: IconUsers,
                  },
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
                <div className="flex gap-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-red-500/15">
                    <IconAlertTriangle size={20} className="text-red-400" stroke={1.5} />
                  </div>
                  <div>
                    <p className="mb-1 font-semibold text-red-400">Within 72 Hours of Event</p>
                    <p className="text-sm leading-relaxed text-red-300/80">
                      All headcounts and sales are final. Our team and vendors need time to prepare
                      for your event — changes cannot be made within 72 hours.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <label className="mb-4 flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-[#071027] p-5">
              <input
                type="checkbox"
                checked={policyAcknowledged}
                onChange={(e) => setPolicyAcknowledged(e.target.checked)}
                className="h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500"
              />
              <span className="text-sm font-semibold text-white">
                I have read and agree to the cancellation policy
              </span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setStep("tips")}
                className="rounded-xl border border-white/20 py-4 font-semibold hover:bg-white/5"
              >
                Back
              </button>
              <button
                onClick={() => setStep("sign")}
                disabled={!policyAcknowledged}
                className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-4 text-lg font-bold shadow-lg shadow-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
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
                We&apos;re excited to create lasting memories at {quote.centerName}! Confirm the
                details and sign below.
              </p>

              <div className="space-y-3">
                {[
                  {
                    state: agreeDeposit,
                    set: setAgreeDeposit,
                    text: "I agree to make a 50% deposit via credit card after completing this document.",
                  },
                  {
                    state: agreeNoPrepay,
                    set: setAgreeNoPrepay,
                    text: "I understand that the remaining balance will be automatically charged to my card on file 72 hours prior to the event.",
                  },
                ].map((item, i) => (
                  <label
                    key={i}
                    className="flex cursor-pointer items-start gap-3 rounded-lg bg-white/5 p-3"
                  >
                    <input
                      type="checkbox"
                      checked={item.state}
                      onChange={(e) => item.set(e.target.checked)}
                      className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500"
                    />
                    <span className="text-sm text-gray-300">{item.text}</span>
                  </label>
                ))}

                <div className="rounded-xl bg-white/5 p-4">
                  <p className="mb-3 font-semibold text-white">Are you tax exempt?</p>
                  {quote.isTaxExempt ? (
                    <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-sm text-emerald-400">
                      This event is tax exempt based on the event products. Please upload your DR-14
                      certificate below.
                    </div>
                  ) : (
                    <div className="flex gap-4">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="tax"
                          checked={taxExempt === "yes"}
                          onChange={() => setTaxExempt("yes")}
                          className="h-4 w-4 text-cyan-500"
                        />
                        <span className="text-sm">Yes</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="tax"
                          checked={taxExempt === "no"}
                          onChange={() => setTaxExempt("no")}
                          className="h-4 w-4 text-cyan-500"
                        />
                        <span className="text-sm">No</span>
                      </label>
                    </div>
                  )}
                  {taxExempt === "yes" && (
                    <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                      <p className="mb-2 text-sm font-semibold text-amber-400">
                        Upload DR-14 Tax Exempt Letter
                      </p>
                      <p className="mb-3 text-xs text-gray-400">
                        Required to apply tax exemption. PDF, JPG, or PNG accepted.
                      </p>
                      {taxFileUrl ? (
                        <div className="flex items-center gap-2 rounded-lg bg-emerald-400/10 px-3 py-2 text-sm text-emerald-400">
                          <svg
                            className="h-4 w-4 flex-shrink-0"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="truncate">{taxFile?.name || "Uploaded"}</span>
                        </div>
                      ) : (
                        <label
                          className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm transition-colors ${taxUploading ? "border-cyan-400/30 text-cyan-400" : "border-white/20 text-gray-400 hover:border-cyan-400/40 hover:text-cyan-300"}`}
                        >
                          {taxUploading ? (
                            <>
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />{" "}
                              Uploading...
                            </>
                          ) : (
                            <>
                              <svg
                                className="h-5 w-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                                />
                              </svg>{" "}
                              Choose file
                            </>
                          )}
                          <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setTaxFile(file);
                              setTaxUploading(true);
                              try {
                                const form = new FormData();
                                form.append("file", file);
                                form.append("shortId", quote.contractShortId);
                                const res = await fetch("/api/group-function/upload-tax-doc", {
                                  method: "POST",
                                  body: form,
                                });
                                const data = await res.json();
                                if (data.url) setTaxFileUrl(data.url);
                                else setError(data.error || "Upload failed");
                              } catch {
                                setError("Upload failed. Please try again.");
                              } finally {
                                setTaxUploading(false);
                              }
                            }}
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-white/5 p-3">
                  <input
                    type="checkbox"
                    checked={agreeUnderstand}
                    onChange={(e) => setAgreeUnderstand(e.target.checked)}
                    className="mt-0.5 h-5 w-5 flex-shrink-0 rounded border-gray-600 bg-gray-800 text-cyan-500"
                  />
                  <span className="text-sm text-gray-300">
                    I understand that my tax exempt answer cannot be changed at the time of the
                    event.
                  </span>
                </label>
              </div>

              {/* Signature */}
              <div className="mt-6 border-t border-white/10 pt-6">
                <p className="mb-3 text-sm font-semibold text-gray-400">Guest Signature</p>
                <div className="mb-3 flex gap-2">
                  <button
                    onClick={() => setSigType("type")}
                    className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${sigType === "type" ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40" : "bg-white/5 text-gray-500"}`}
                  >
                    Type
                  </button>
                  <button
                    onClick={() => setSigType("draw")}
                    className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${sigType === "draw" ? "bg-cyan-400/20 text-cyan-400 ring-1 ring-cyan-400/40" : "bg-white/5 text-gray-500"}`}
                  >
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
                      style={{ touchAction: "none" }}
                      className="w-full cursor-crosshair rounded-lg border border-white/20 bg-[#0a1628]"
                    />
                    <button
                      onClick={clearCanvas}
                      className="absolute right-2 top-2 rounded bg-white/10 px-2 py-0.5 text-xs text-gray-400 hover:bg-white/20"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Compliance footer */}
              <p className="mt-4 text-[10px] text-gray-600">
                By signing, you consent to use electronic signatures per the ESIGN Act and UETA.
                Your signature, IP address, and timestamp will be recorded for verification
                purposes.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep("policy")}
                className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/5"
              >
                Back
              </button>
              <button
                onClick={handleSign}
                disabled={!allAgreed || !hasSig}
                className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-4 text-lg font-bold shadow-lg shadow-cyan-500/20 disabled:opacity-40"
              >
                Sign & Continue to Payment
              </button>
            </div>
          </>
        )}

        {/* ═══ Step 5: Pay Deposit ═══ */}
        {step === "pay" && (
          <>
            <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-500/10 px-4 py-3 ring-1 ring-emerald-500/20">
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
                Contract signed{signedAt ? ` at ${new Date(signedAt).toLocaleTimeString()}` : ""}!
                Now secure your date.
              </p>
            </div>

            <div className="mb-6 rounded-2xl border border-white/10 bg-[#071027] p-6">
              <h2 className="mb-1 text-xl font-bold">Secure Your Event</h2>
              <p className="mb-6 text-sm text-gray-400">
                Deposit:{" "}
                <span className="font-semibold text-white">
                  {fmtDollars(quote.depositDueCents)}
                </span>
                {quote.balanceCents > 0 &&
                  ` — remaining ${fmtDollars(quote.balanceCents)} charged 72 hours before event.`}
              </p>

              <div id="sq-card-container" className="mb-4 min-h-[50px] rounded-lg bg-white p-3" />

              <div className="mb-5 flex items-start gap-2.5 rounded-lg bg-white/5 p-3">
                <svg
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-cyan-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="text-sm text-gray-300">
                  Your card will be saved on file. The remaining balance of{" "}
                  <strong className="text-white">{fmtDollars(quote.balanceCents)}</strong> will be
                  automatically charged 72 hours prior to your event.
                </p>
              </div>

              {error && (
                <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-200 ring-1 ring-red-500/20">
                  {error}
                </div>
              )}

              <button
                onClick={handlePay}
                disabled={processing}
                className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-cyan-500/20 disabled:opacity-50"
              >
                {processing ? "Processing..." : `Pay ${fmtDollars(quote.depositDueCents)} Deposit`}
              </button>
            </div>
          </>
        )}

        {/* ═══ Event Dashboard (post-deposit) ═══ */}
        {step === "event" && (
          <div className="mt-4 space-y-6">
            {/* Event details card with countdown integrated */}
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#071027]">
              <div className="grid md:grid-cols-[1fr_auto]">
                <div className="p-6">
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-400">
                    Event Details
                  </h2>
                  <h3 className="mb-4 text-2xl font-bold">{quote.eventName}</h3>

                  {/* Countdown inline */}
                  <EventCountdownInline eventDate={quote.eventDate} />

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
                        <span className="font-medium">
                          {fmtDollars(Math.round(item.total * 100))}
                        </span>
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
                  <Image
                    src={`${BLOB}/attractions/DSC06577.webp`}
                    alt="Racing"
                    fill
                    className="object-cover"
                    unoptimized
                  />
                  <div className="absolute inset-0 bg-gradient-to-r from-[#071027] to-transparent" />
                </div>
              </div>
            </div>

            {/* Payment summary */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-400/10">
                    <IconCircleCheck size={20} className="text-emerald-400" stroke={1.5} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
                      Deposit Paid
                    </p>
                    <p className="text-2xl font-extrabold">{fmtDollars(quote.depositDueCents)}</p>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[#071027] p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-400/10">
                    <IconCreditCard size={20} className="text-cyan-400" stroke={1.5} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                      Balance Due (72hrs before)
                    </p>
                    <p className="text-2xl font-extrabold">{fmtDollars(quote.balanceCents)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Waiver link */}
            {eventDetails?.waiverUrl && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-red-500/10">
                    <IconShieldCheck size={20} className="text-red-400" stroke={1.5} />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-white">Complete Your Waivers</p>
                    <p className="mt-1 text-sm text-gray-400">
                      All participants must sign a waiver before the event. Share this link with
                      your group.
                    </p>
                    <p className="mt-1 text-xs font-semibold text-red-400">
                      MANDATORY: Failure to complete waivers is grounds for cancellation.
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href={eventDetails.waiverUrl}
                    target="_blank"
                    rel="noopener"
                    className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-cyan-500/20"
                  >
                    Open Waiver Form
                  </a>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(eventDetails.waiverUrl!);
                    }}
                    aria-label="Copy waiver link"
                    className="flex items-center gap-1.5 rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold hover:bg-white/5"
                  >
                    <IconLink size={16} /> Copy Link
                  </button>
                  <a
                    href={`sms:?body=${encodeURIComponent(`Please complete your waiver for our event: ${eventDetails.waiverUrl}`)}`}
                    className="flex items-center gap-1.5 rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold hover:bg-white/5"
                  >
                    <IconShare size={16} /> Share via Text
                  </a>
                </div>
              </div>
            )}

            {/* Participants */}
            {eventDetails && eventDetails.totalParticipants > 0 && (
              <div className="rounded-2xl border border-white/10 bg-[#071027] p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-400/10">
                      <IconUsers size={20} className="text-cyan-400" stroke={1.5} />
                    </div>
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                      Registered Participants
                    </h3>
                  </div>
                  <div className="rounded-full bg-white/5 px-3 py-1 text-sm">
                    <span className="font-semibold text-emerald-400">
                      {eventDetails.confirmedCount}
                    </span>
                    <span className="text-gray-500">
                      {" "}
                      / {eventDetails.totalParticipants} confirmed
                    </span>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="mb-4 h-2 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-all duration-500"
                    style={{
                      width: `${Math.round((eventDetails.confirmedCount / eventDetails.totalParticipants) * 100)}%`,
                    }}
                  />
                </div>
                <div className="space-y-1">
                  {eventDetails.participants.map((p, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
                    >
                      <span className="text-gray-300">{p.name}</span>
                      {p.confirmed ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <IconCircleCheck size={14} /> Confirmed
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500">Pending</span>
                      )}
                    </div>
                  ))}
                  {eventDetails.totalParticipants > eventDetails.participants.length && (
                    <p className="pt-2 text-center text-xs text-gray-500">
                      + {eventDetails.totalParticipants - eventDetails.participants.length} more
                      participants
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Planner notes (live) */}
            {eventDetails?.notes && (
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-5">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-cyan-400">
                  Notes from {quote.plannerFirst || "Your Planner"}
                </h3>
                <p className="whitespace-pre-line text-sm leading-relaxed text-gray-300">
                  {eventDetails.notes}
                </p>
              </div>
            )}

            {/* Planner contact */}
            {quote.plannerFirst && (
              <div className="rounded-2xl border border-white/10 bg-[#071027] p-5">
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
                        aria-label="Call planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-600 transition-colors hover:bg-cyan-500"
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
                        aria-label="Text planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
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
                        aria-label="Email planner"
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
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
              </div>
            )}

            {/* Update Card on File */}
            {!alreadyPaid || quote.status === "deposit_paid" || quote.status === "balance_link_sent"
              ? null
              : null}
            <UpdateCardSection
              shortId={quote.contractShortId}
              locationId={quote.squareLocationId}
            />

            {/* Downloads / Actions */}
            <div className="flex flex-wrap justify-center gap-3">
              {signedPdfUrl && (
                <a
                  href={signedPdfUrl}
                  target="_blank"
                  rel="noopener"
                  className="flex items-center gap-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-cyan-500/20"
                >
                  <IconClipboardCheck size={16} /> View Signed Contract
                </a>
              )}
              <a
                href={`data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(quote))}`}
                download={`${quote.eventName || "Event"}.ics`}
                className="flex items-center gap-2 rounded-full bg-white/10 px-6 py-2.5 text-sm font-semibold hover:bg-white/20"
              >
                <IconCalendarEvent size={16} /> Add to Calendar
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

function EventCountdownInline({ eventDate }: { eventDate: string }) {
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
    <div className="mb-4 flex items-center gap-3 rounded-xl bg-cyan-400/5 px-4 py-2.5 ring-1 ring-cyan-400/10">
      <IconClock size={16} className="flex-shrink-0 text-cyan-400" />
      <div className="flex items-baseline gap-1 text-sm">
        {diff.days > 0 && (
          <>
            <span className="font-bold tabular-nums text-cyan-400">{diff.days}</span>
            <span className="text-gray-500">d</span>
          </>
        )}
        <span className="font-bold tabular-nums text-cyan-400">{diff.hours}</span>
        <span className="text-gray-500">h</span>
        <span className="font-bold tabular-nums text-cyan-400">{diff.mins}</span>
        <span className="text-gray-500">m</span>
        <span className="ml-1 text-gray-400">until your event</span>
      </div>
    </div>
  );
}

function UpdateCardSection({ shortId, locationId }: { shortId: string; locationId: string }) {
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<{ last4: string; brand: string } | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const updateCardRef = useRef<{
    tokenize: () => Promise<{
      status: string;
      token?: string;
      errors?: Array<{ message: string }>;
    }>;
    destroy: () => void;
  } | null>(null);
  const cardLoaded = useRef(false);

  useEffect(() => {
    if (!open || cardLoaded.current) return;
    cardLoaded.current = true;
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
        const payments = await window.Square!.payments(SQUARE_APP_ID, locationId);
        const card = await payments.card();
        await card.attach("#sq-update-card-container");
        updateCardRef.current = card;
      } catch {
        setCardError("Failed to load card form.");
      }
    })();
  }, [open, locationId]);

  async function handleUpdate() {
    if (!updateCardRef.current) return;
    setUpdating(true);
    setCardError(null);
    try {
      const tokenResult = await updateCardRef.current.tokenize();
      if (tokenResult.status !== "OK" || !tokenResult.token) {
        setCardError(tokenResult.errors?.[0]?.message || "Card verification failed");
        return;
      }
      const res = await fetch("/api/group-function/update-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractShortId: shortId, cardSourceId: tokenResult.token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCardError(data.error || "Failed");
        return;
      }
      setResult(data);
    } catch {
      setCardError("Failed to update card.");
    } finally {
      setUpdating(false);
    }
  }

  if (result) {
    return (
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-center">
        <p className="font-semibold text-emerald-400">Card Updated</p>
        <p className="mt-1 text-sm text-gray-400">
          {result.brand} ending in {result.last4}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-[#071027] p-5">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-sm font-semibold"
      >
        <span className="flex items-center gap-2">
          <IconCreditCard size={16} className="text-cyan-400" />
          Update Card on File
        </span>
        <span className="text-gray-500">{open ? "▲" : "▼"}</span>
      </button>
      <div className={open ? "mt-4" : "hidden"}>
        <div id="sq-update-card-container" className="mb-4" />
        {cardError && <p className="mb-3 text-sm text-red-400">{cardError}</p>}
        <button
          onClick={handleUpdate}
          disabled={updating}
          className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 py-3 font-bold disabled:opacity-40"
        >
          {updating ? "Updating..." : "Save New Card"}
        </button>
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
