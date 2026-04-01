"use client";

import { useState, useEffect } from "react";
import type { SmsBill } from "../data";

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function cashTotal(bill: SmsBill): number {
  return bill.total.find(p => p.depositKind === 0)?.amount ?? 0;
}

export default function ConfirmationPage() {
  const [bill, setBill] = useState<SmsBill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [billId, setBillId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("billId");
    setBillId(id);
    if (!id) {
      setError("No booking ID found.");
      setLoading(false);
      return;
    }

    async function processAndLoad() {
      try {
        // Check if we need to process a payment
        // Square payment links: may have transactionId param
        // BMI genericpaymentprocessor: may have providerKind + data + transactionId
        const providerKind = params.get("providerKind");
        const data = params.get("data");
        const transactionId = params.get("transactionId");
        const orderId = params.get("orderId");

        if (providerKind && data && transactionId) {
          // BMI payment redirect — call payment/process
          await fetch("/api/sms?endpoint=payment%2Fprocess", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paymentProviderKind: Number(providerKind),
              paymentMode: 0,
              extraData: { providerKind, data, transactionId, orderId: orderId ?? id },
            }),
          });
        } else if (transactionId || params.has("checkoutId")) {
          // Square payment link redirect — call payment/process with Square transaction
          await fetch("/api/sms?endpoint=payment%2Fprocess", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paymentProviderKind: -11042,
              paymentMode: 0,
              extraData: {
                providerKind: "-11042",
                transactionId: transactionId || params.get("checkoutId") || id,
                orderId: id,
              },
            }),
          });
        }

        // Clean up URL params after processing
        if (transactionId || providerKind || params.has("checkoutId")) {
          window.history.replaceState({}, "", `/book/racing/confirmation?billId=${id}`);
        }

        // Fetch bill overview
        const res = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${encodeURIComponent(id!)}`);
        const bill: SmsBill = await res.json();
        setBill(bill);
      } catch {
        setError("Couldn't load booking details.");
      } finally {
        setLoading(false);
      }
    }

    processAndLoad();
  }, []);

  // Find the race line (first non-waiver line)
  const raceLine = bill?.lines.find(l => l.scheduledTime);
  const start = raceLine?.scheduledTime?.start;
  const total = bill ? cashTotal(bill) : null;

  return (
    <div className="min-h-screen bg-[#000418] pt-24">
      <div className="max-w-lg mx-auto px-4 py-12">

        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 min-h-[300px]">
            <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Loading your booking…</p>
          </div>
        )}

        {!loading && error && (
          <div className="text-center space-y-4">
            <p className="text-red-400">{error}</p>
            <a href="/book/racing" className="text-[#00E2E5] underline text-sm">Book a race</a>
          </div>
        )}

        {!loading && bill && (
          <div className="space-y-6">
            {/* Success header */}
            <div className="text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-[#00E2E5]/15 border border-[#00E2E5]/40 flex items-center justify-center mx-auto text-3xl">
                ✓
              </div>
              <h1 className="text-3xl font-display uppercase tracking-widest text-white">
                You&apos;re on the grid!
              </h1>
              <p className="text-white/50 text-sm">
                Your race is confirmed. Check your email for a receipt.
              </p>
            </div>

            {/* Booking details */}
            <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/8">
              {raceLine && (
                <div className="p-4">
                  <p className="text-white/40 text-xs mb-1">Race</p>
                  <p className="text-white font-bold">{raceLine.name}</p>
                </div>
              )}
              {start && (
                <div className="p-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-white/40 text-xs mb-1">Date</p>
                    <p className="text-white text-sm">{formatDate(start)}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs mb-1">Heat time</p>
                    <p className="text-white text-sm">{formatTime(start)}</p>
                  </div>
                </div>
              )}
              {raceLine && (
                <div className="p-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-white/40 text-xs mb-1">Racers</p>
                    <p className="text-white text-sm">{raceLine.quantity}</p>
                  </div>
                  {total !== null && (
                    <div>
                      <p className="text-white/40 text-xs mb-1">Total paid</p>
                      <p className="text-[#00E2E5] font-bold text-lg">${total.toFixed(2)}</p>
                    </div>
                  )}
                </div>
              )}
              {billId && (
                <div className="p-4">
                  <p className="text-white/40 text-xs mb-1">Booking reference</p>
                  <p className="text-white/70 text-sm font-mono">{billId}</p>
                </div>
              )}
            </div>

            {/* Reminders */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/50 space-y-2">
              <p className="font-semibold text-white/70 mb-2">Before you arrive</p>
              <p>· Arrive <strong className="text-white/70">30 minutes early</strong> for check-in and kart assignment.</p>
              <p>· Stop at <strong className="text-white/70">Guest Services (2nd floor)</strong> first — waivers, height checks, and credentials.</p>
              <p>· A <strong className="text-white/70">$4.99 license fee</strong> per driver applies at first check-in.</p>
              <p>· Closed-toe shoes required. No loose clothing.</p>
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <a
                href="/racing"
                className="flex-1 text-center px-6 py-3 rounded-xl border border-white/20 text-white/70 hover:border-white/40 hover:text-white text-sm font-semibold transition-colors"
              >
                Racing info
              </a>
              <a
                href="/book/racing"
                className="flex-1 text-center px-6 py-3 rounded-xl bg-[#00E2E5] text-[#000418] hover:bg-white text-sm font-bold transition-colors shadow-lg shadow-[#00E2E5]/25"
              >
                Book another race
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
