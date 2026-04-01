"use client";

import { useEffect, useState } from "react";

export default function ConfirmationPage() {
  const [orderId, setOrderId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setOrderId(params.get("orderId"));
  }, []);

  return (
    <div className="min-h-screen bg-[#000418] pt-24">
      {/* Dev banner */}
      <div className="bg-yellow-500/90 text-black text-center text-xs font-semibold py-1.5 px-4">
        Development — Using BMI Public API
      </div>

      <div className="max-w-lg mx-auto px-4 py-12">
        {!orderId ? (
          <div className="text-center space-y-4">
            <p className="text-red-400">No order ID found.</p>
            <a href="/book/race" className="text-[#00E2E5] underline text-sm">
              Book a race
            </a>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Success header */}
            <div className="text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-[#00E2E5]/15 border border-[#00E2E5]/40 flex items-center justify-center mx-auto text-3xl">
                &#10003;
              </div>
              <h1 className="text-3xl font-display uppercase tracking-widest text-white">
                You&apos;re on the grid!
              </h1>
              <p className="text-white/50 text-sm">
                Your booking has been confirmed.
              </p>
            </div>

            {/* Order reference */}
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-white/40 text-xs mb-1">Order reference</p>
              <p className="text-white/70 text-sm font-mono">{orderId}</p>
            </div>

            {/* Reminders */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/50 space-y-2">
              <p className="font-semibold text-white/70 mb-2">Before you arrive</p>
              <p>
                · Arrive{" "}
                <strong className="text-white/70">30 minutes early</strong> for
                check-in and kart assignment.
              </p>
              <p>
                · Stop at{" "}
                <strong className="text-white/70">
                  Guest Services (2nd floor)
                </strong>{" "}
                first — waivers, height checks, and credentials.
              </p>
              <p>
                · A{" "}
                <strong className="text-white/70">$4.99 license fee</strong> per
                driver applies at first check-in.
              </p>
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
                href="/book/race"
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
