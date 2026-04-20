"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";

export default function CheckoutConfirmation() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resNumber, setResNumber] = useState("");
  const confirmStarted = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billId = params.get("billId");
    if (!billId) { setError("No booking ID found."); setLoading(false); return; }

    async function confirm() {
      if (confirmStarted.current) return;
      confirmStarted.current = true;

      try {
        // Get stored amount
        let amount = 0;
        try {
          const storeRes = await fetch(`/api/booking-store?billId=${billId}`);
          if (storeRes.ok) {
            const details = await storeRes.json();
            amount = parseFloat(details.amount || "0");
          }
        } catch { /* skip */ }

        // Confirm payment
        const depositKind = amount === 0 ? 2 : 0;
        const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${amount},"orderId":${billId},"depositKind":${depositKind}}`;
        const qs = new URLSearchParams({ endpoint: "payment/confirm" });
        const confirmRes = await fetch(`/api/bmi?${qs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: confirmBody,
        });
        const result = await confirmRes.json();
        if (result.reservationNumber) {
          setResNumber(result.reservationNumber);
          // Link participants to schedule (fire-and-forget)
          try {
            const recordRes = await fetch(`/api/booking-record?billId=${billId}`);
            if (recordRes.ok) {
              const record = await recordRes.json();
              if (record.racers && Array.isArray(record.racers) && record.racers.length > 0) {
                fetch("/api/pandora/schedule", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ resNumber: result.reservationNumber, racers: record.racers }),
                }).catch(() => {});
              }
            }
          } catch { /* non-fatal */ }
        }

        // Clean up
        sessionStorage.removeItem("attractionCart");
        sessionStorage.removeItem("attractionOrderId");
        localStorage.removeItem(`booking_${billId}`);

        if (!window.location.hostname.includes("localhost")) {
          window.history.replaceState({}, "", "/book/checkout/confirmation");
        }
      } catch {
        setError("Could not confirm booking.");
      } finally {
        setLoading(false);
      }
    }
    confirm();
  }, []);

  return (
    <div className="min-h-screen bg-[#000418]">
      <Nav />
      <div className="max-w-md mx-auto px-4 pt-32 sm:pt-36 pb-16">
        {loading && (
          <div className="flex flex-col items-center gap-4 py-16">
            <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Confirming your booking...</p>
          </div>
        )}

        {!loading && error && (
          <div className="text-center space-y-4 py-16">
            <p className="text-red-400">{error}</p>
            <Link href="/book" className="text-[#00E2E5] underline text-sm">Back to experiences</Link>
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-6 text-center">
            <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto">
              <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-3xl font-display uppercase tracking-widest text-white">
              You&apos;re All Set!
            </h1>
            <p className="text-white/50 text-sm">Your booking is confirmed. See you soon!</p>

            {resNumber && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                <p className="text-white/40 text-xs mb-1">Reservation</p>
                <p className="text-[#00E2E5] font-bold text-2xl">{resNumber}</p>
              </div>
            )}

            <div className="flex flex-col gap-3 pt-4">
              <Link href="/book" className="w-full py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors text-center shadow-lg shadow-[#00E2E5]/25">
                Book More Activities
              </Link>
              <Link href="/" className="w-full py-3 rounded-xl border border-white/15 text-white/60 hover:border-white/30 hover:text-white text-sm font-semibold transition-colors text-center">
                Back to Home
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
