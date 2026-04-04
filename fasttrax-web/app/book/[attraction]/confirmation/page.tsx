"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/Nav";
import { ATTRACTIONS, bmiPost } from "@/lib/attractions-data";
import type { AttractionConfig } from "@/lib/attractions-data";

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatTime(iso: string) {
  return parseLocal(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string) {
  return parseLocal(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// ── Types ───────────────────────────────────────────────────────────────────

interface OrderOverview {
  orderId: number;
  date?: string;
  subTotal: { amount: number; depositKind: number }[];
  total: { amount: number; depositKind: number }[];
  totalTax: { amount: number; depositKind: number }[];
  totalPaid: number;
  lines: {
    name: string;
    quantity: number;
    totalPrice: { amount: number; depositKind: number }[];
    scheduledTime?: { start: string; stop: string } | null;
    schedules?: { start: string; stop?: string; name?: string }[];
    productGroup: string;
  }[];
  scheduleDays?: { date: string; schedules: { start: string; stop?: string; name?: string }[] }[];
}

type ConfirmState =
  | { status: "confirming" }
  | { status: "confirmed"; resNumber: string; order: OrderOverview }
  | { status: "error"; message: string };

// ── Page ────────────────────────────────────────────────────────────────────

export default function AttractionConfirmationPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params.attraction as string;
  const config = ATTRACTIONS[slug] as AttractionConfig | undefined;
  const billId = searchParams.get("billId");

  const [state, setState] = useState<ConfirmState>({ status: "confirming" });
  const confirmStarted = useRef(false);

  useEffect(() => {
    if (confirmStarted.current || !billId) return;
    confirmStarted.current = true;
    confirmPayment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billId]);

  async function confirmPayment() {
    if (!billId) {
      setState({ status: "error", message: "Missing booking reference." });
      return;
    }

    try {
      // Confirm payment with BMI
      const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${billId},"depositKind":0}`;
      const qs = new URLSearchParams({ endpoint: "payment/confirm" });
      const confirmRes = await fetch(`/api/bmi?${qs.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: confirmBody,
      });
      const confirmResult = await confirmRes.json();
      const resNumber = confirmResult.reservationNumber || confirmResult.confirmationNumber || "";

      // Get the final order overview
      const overviewRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${billId}`);
      const overview: OrderOverview = await overviewRes.json();

      setState({ status: "confirmed", resNumber: String(resNumber), order: overview });
    } catch (err) {
      // If payment/confirm fails (e.g. already confirmed), try to just get the overview
      try {
        const overviewRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${billId}`);
        const overview: OrderOverview = await overviewRes.json();
        setState({ status: "confirmed", resNumber: "", order: overview });
      } catch {
        setState({ status: "error", message: "Failed to confirm your booking. Please contact us." });
      }
    }
  }

  const color = config?.color || "#00E2E5";
  const attractionName = config?.name || "Your Booking";

  // Loading
  if (state.status === "confirming") {
    return (
      <div className="min-h-screen bg-[#000418]">
        <Nav />
        <div className="pt-32 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: color }} />
          <p className="text-white/60 text-sm">Confirming your booking...</p>
        </div>
      </div>
    );
  }

  // Error
  if (state.status === "error") {
    return (
      <div className="min-h-screen bg-[#000418]">
        <Nav />
        <div className="pt-32 px-4 max-w-md mx-auto text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-500/10 flex items-center justify-center mb-6">
            <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h1 className="text-2xl font-display text-white uppercase tracking-widest mb-3">Something Went Wrong</h1>
          <p className="text-white/50 text-sm mb-6">{state.message}</p>
          <div className="flex flex-col gap-3">
            <Link href="/book" className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-white/10 text-white hover:bg-white/15 transition-colors">
              Back to Experiences
            </Link>
            <a href="tel:+12392752226" className="text-white/40 text-xs hover:text-white/60 transition-colors">
              Need help? Call (239) 275-2226
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Confirmed
  const { resNumber, order } = state;

  // Extract schedule info from the order
  const firstLine = order.lines?.[0];
  const scheduleStart = firstLine?.scheduledTime?.start || firstLine?.schedules?.[0]?.start || order.scheduleDays?.[0]?.schedules?.[0]?.start;
  const scheduleStop = firstLine?.scheduledTime?.stop || firstLine?.schedules?.[0]?.stop;
  const cashTotal = order.total?.find(t => t.depositKind === 0);

  return (
    <div className="min-h-screen bg-[#000418]">
      <Nav />

      <div className="pt-28 sm:pt-36 pb-20 px-4">
        <div className="max-w-md mx-auto space-y-8">

          {/* Success header */}
          <div className="text-center">
            <div
              className="w-20 h-20 mx-auto rounded-full flex items-center justify-center mb-6"
              style={{ backgroundColor: `${color}15` }}
            >
              <svg className="w-10 h-10" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="font-display text-3xl sm:text-4xl text-white uppercase tracking-widest mb-2">
              You're Booked!
            </h1>
            <p className="text-white/50 text-sm">{attractionName}</p>
            {resNumber && (
              <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/15 bg-white/5">
                <span className="text-white/50 text-xs">Reservation #</span>
                <span className="text-white font-bold font-mono text-lg">{resNumber}</span>
              </div>
            )}
          </div>

          {/* Booking details card */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="p-5 space-y-4">
              {/* Date & Time */}
              {scheduleStart && (
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}15` }}>
                    <svg className="w-5 h-5" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <path d="M16 2v4M8 2v4M3 10h18" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white font-medium text-sm">{formatDate(scheduleStart)}</p>
                    <p className="text-white/50 text-xs">
                      {formatTime(scheduleStart)}
                      {scheduleStop ? ` — ${formatTime(scheduleStop)}` : ""}
                    </p>
                  </div>
                </div>
              )}

              {/* Location */}
              {config && (
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}15` }}>
                    <svg className="w-5 h-5" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white font-medium text-sm">{config.building}</p>
                    <p className="text-white/50 text-xs">
                      {config.location === "headpinz" || config.location === "both"
                        ? "14513 Global Pkwy, Fort Myers"
                        : "4500 Ford St Extension, Fort Myers"
                      }
                    </p>
                  </div>
                </div>
              )}

              {/* Line items */}
              {order.lines && order.lines.length > 0 && (
                <div className="pt-3 border-t border-white/8 space-y-2">
                  {order.lines.map((line, i) => {
                    const cashPrice = line.totalPrice?.find(p => p.depositKind === 0);
                    return (
                      <div key={i} className="flex items-center justify-between">
                        <div>
                          <p className="text-white text-sm">{line.name}</p>
                          {line.quantity > 1 && <p className="text-white/40 text-xs">Qty: {line.quantity}</p>}
                        </div>
                        <p className="text-white/60 text-sm">${(cashPrice?.amount ?? 0).toFixed(2)}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Total */}
              {cashTotal && (
                <div className="pt-3 border-t border-white/8 flex justify-between">
                  <span className="text-white font-bold">Total Paid</span>
                  <span className="font-bold" style={{ color }}>${cashTotal.amount.toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Waiver reminder */}
          {config?.showWaiverPrompt && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <div>
                  <p className="text-amber-300 font-bold text-sm mb-1">Waiver Required</p>
                  <p className="text-amber-200/60 text-xs leading-relaxed">
                    All participants must complete a waiver before playing. You can do this online ahead of time or at the check-in kiosk.
                  </p>
                  <a
                    href="https://kiosk.bmileisure.com/headpinzftmyers"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 mt-3 text-amber-300 text-xs font-medium hover:text-amber-200 transition-colors"
                  >
                    Complete Waiver Now
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-3">
            <Link
              href="/book"
              className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl font-bold text-sm text-[#000418] transition-all hover:brightness-110"
              style={{ backgroundColor: color }}
            >
              Add Another Activity
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </Link>

            <Link
              href="/book/race"
              className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl font-bold text-sm text-white border border-white/15 bg-white/5 hover:bg-white/10 transition-colors"
            >
              Book Racing
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </Link>
          </div>

          {/* Help */}
          <p className="text-center text-white/30 text-xs">
            Questions? Call us at{" "}
            <a href="tel:+12392752226" className="text-white/50 hover:text-white/70 transition-colors">
              (239) 275-2226
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
