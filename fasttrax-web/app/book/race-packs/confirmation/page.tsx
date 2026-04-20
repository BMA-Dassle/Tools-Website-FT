"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { trackBookingComplete } from "@/lib/analytics";

export default function RacePackConfirmation() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [packName, setPackName] = useState("");
  const [personName, setPersonName] = useState("");
  const [amount, setAmount] = useState("");
  const [resNumber, setResNumber] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const confirmStarted = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billId = params.get("billId");

    if (!billId) {
      setError("No booking ID found.");
      setLoading(false);
      return;
    }

    async function confirm() {
      if (confirmStarted.current) return;
      confirmStarted.current = true;

      try {
        // Get booking details from Redis or localStorage
        let details: Record<string, string> | null = null;
        try {
          const res = await fetch(`/api/booking-store?billId=${billId}`);
          if (res.ok) details = await res.json();
        } catch { /* Redis unavailable */ }
        if (!details) {
          const stored = localStorage.getItem(`booking_${billId}`);
          if (stored) details = JSON.parse(stored);
        }

        if (details) {
          setPackName(details.race || "Race Pack");
          setPersonName(details.name || "");
          setAmount(details.amount || "0");
          if (details.loginCode) setLoginCode(details.loginCode);
        }

        // Confirm payment with BMI
        const amt = details?.amount ? parseFloat(details.amount) : 0;
        const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${amt},"orderId":${billId},"depositKind":0}`;
        const qs = new URLSearchParams({ endpoint: "payment/confirm" });
        const confirmRes = await fetch(`/api/bmi?${qs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: confirmBody,
        });
        const result = await confirmRes.json();
        if (result.reservationNumber) setResNumber(result.reservationNumber);
        trackBookingComplete(result.reservationNumber || billId!);

        // Clean up
        localStorage.removeItem(`booking_${billId}`);

        if (!window.location.hostname.includes("localhost")) {
          window.history.replaceState({}, "", "/book/race-packs/confirmation");
        }
      } catch {
        setError("Could not confirm payment.");
      } finally {
        setLoading(false);
      }
    }

    confirm();
  }, []);

  return (
    <div className="min-h-screen bg-[#000418] pt-32">
      <div className="max-w-md mx-auto px-4 py-12">
        {loading && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Confirming your purchase...</p>
          </div>
        )}

        {!loading && error && (
          <div className="text-center space-y-4">
            <p className="text-red-400">{error}</p>
            <Link href="/book/race-packs" className="text-[#00E2E5] underline text-sm">Back to Race Packs</Link>
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-6 text-center">
            {/* Success */}
            <div className="space-y-3">
              <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto">
                <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-3xl font-display uppercase tracking-widest text-white">
                Credits Loaded!
              </h1>
              {personName && (
                <p className="text-white/60 text-sm">
                  {packName} credits have been added to <strong className="text-white">{personName}</strong>&apos;s account.
                </p>
              )}
            </div>

            {/* Details */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3 text-left">
              {packName && (
                <div className="flex justify-between">
                  <span className="text-white/40 text-sm">Pack</span>
                  <span className="text-white text-sm font-semibold">{packName}</span>
                </div>
              )}
              {personName && (
                <div className="flex justify-between">
                  <span className="text-white/40 text-sm">Racer</span>
                  <span className="text-white text-sm">{personName}</span>
                </div>
              )}
              {amount && parseFloat(amount) > 0 && (
                <div className="flex justify-between">
                  <span className="text-white/40 text-sm">Paid</span>
                  <span className="text-[#00E2E5] font-bold">${parseFloat(amount).toFixed(2)}</span>
                </div>
              )}
              {resNumber && (
                <div className="flex justify-between">
                  <span className="text-white/40 text-sm">Reference</span>
                  <span className="text-white/50 text-xs font-mono">{resNumber}</span>
                </div>
              )}
            </div>

            {/* What's next */}
            <div className="rounded-2xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-5">
              <p className="text-[#00E2E5] font-bold text-sm mb-1">What&apos;s Next?</p>
              <p className="text-white/60 text-xs">
                Credits are ready to use. Book a race and they&apos;ll be applied automatically at checkout.
              </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3 pt-2">
              <a
                href={loginCode ? `/book/race?code=${encodeURIComponent(loginCode)}` : "/book/race"}
                className="w-full py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25 text-center"
              >
                Book a Race Now
              </a>
              <Link
                href="/book/race-packs"
                className="w-full py-3 rounded-xl border border-white/15 text-white/60 hover:border-white/30 hover:text-white text-sm font-semibold transition-colors text-center"
              >
                Buy Another Pack
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
