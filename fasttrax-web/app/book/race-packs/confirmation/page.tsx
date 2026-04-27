"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { trackBookingComplete } from "@/lib/analytics";

interface DepositRow {
  OUT_DPK_ID: number;
  OUT_DPK_NAME: string;
  OUT_DPS_AMOUNT: number;
}

export default function RacePackConfirmation() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [packName, setPackName] = useState("");
  const [personName, setPersonName] = useState("");
  const [amount, setAmount] = useState("");
  const [resNumber, setResNumber] = useState("");
  const [loginCode, setLoginCode] = useState("");
  // Via-deposit flow: balance + credit-pending state. Both no-op
  // when the legacy BMI flow runs.
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [creditKindName, setCreditKindName] = useState("");
  const [creditPending, setCreditPending] = useState(false);
  const [creditPendingMsg, setCreditPendingMsg] = useState("");
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

        const isViaDeposit = details?.viaDeposit === "true";

        if (isViaDeposit) {
          // Square + Pandora-deposit path: no BMI bill exists, so
          // we skip the /payment/confirm roundtrip entirely. The
          // credit was applied server-side by /api/square/pay's
          // postPaymentAction. Read sessionStorage to learn whether
          // the credit landed; read the live balance from Pandora
          // to show "current credit: X".

          // Pull the synthetic billId as the reservation reference.
          setResNumber(billId!);

          // Surface "charged but credit pending" if the server-side
          // addDeposit failed. PaymentForm stashes this in
          // sessionStorage before redirecting.
          try {
            const payRaw = sessionStorage.getItem(`payment_${billId}`);
            if (payRaw) {
              const pay = JSON.parse(payRaw) as { depositCreditFailed?: boolean; depositError?: string };
              if (pay.depositCreditFailed) {
                setCreditPending(true);
                setCreditPendingMsg(pay.depositError || "Credit hasn't landed yet — our team has been notified and will reconcile it.");
              }
            }
          } catch { /* sessionStorage unavailable / non-JSON */ }

          // Read live balance for the deposit kind we just credited.
          // No-op gracefully if Pandora is flaky — we still show
          // "credits added" copy from the booking row.
          if (details?.personId && details?.depositKindId) {
            try {
              const balRes = await fetch(`/api/pandora/deposits/${encodeURIComponent(details.personId)}`, { cache: "no-store" });
              if (balRes.ok) {
                const balJson = await balRes.json();
                const rows: DepositRow[] = Array.isArray(balJson?.data) ? balJson.data : [];
                const row = rows.find(r => String(r.OUT_DPK_ID) === String(details!.depositKindId));
                if (row) {
                  setCreditBalance(row.OUT_DPS_AMOUNT);
                  setCreditKindName(row.OUT_DPK_NAME);
                }
              }
            } catch { /* show without balance — booking row still describes the pack */ }
          }

          trackBookingComplete(billId!);
          // Keep the localStorage row around briefly in case the
          // user refreshes — confirmation only flushes on hard nav.
          // Existing behavior already removes it; preserve that.
          localStorage.removeItem(`booking_${billId}`);
          if (!window.location.hostname.includes("localhost")) {
            window.history.replaceState({}, "", "/book/race-packs/confirmation");
          }
          return;
        }

        // Legacy BMI booking/sell flow: confirm the payment with BMI
        // so it commits the order and assigns credits.
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
              <div className={`w-20 h-20 rounded-full ${creditPending ? "bg-amber-500/20 border-amber-500/50" : "bg-green-500/20 border-green-500/50"} border-2 flex items-center justify-center mx-auto`}>
                {creditPending ? (
                  <svg className="w-10 h-10 text-amber-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <h1 className="text-3xl font-display uppercase tracking-widest text-white">
                {creditPending ? "Payment Received" : "Credits Loaded!"}
              </h1>
              {creditPending ? (
                <p className="text-white/60 text-sm">
                  Your card was charged successfully. Credits will be applied shortly — our team has been notified.
                </p>
              ) : personName && (
                <p className="text-white/60 text-sm">
                  {packName} credits have been added to <strong className="text-white">{personName}</strong>&apos;s account.
                </p>
              )}
            </div>

            {/* Pending-credit banner — only when via-deposit credit step failed */}
            {creditPending && creditPendingMsg && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left">
                <p className="text-amber-400 font-bold text-xs uppercase tracking-wider mb-1">Credits Pending</p>
                <p className="text-white/70 text-xs">{creditPendingMsg}</p>
              </div>
            )}

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
              {creditBalance !== null && (
                <div className="flex justify-between">
                  <span className="text-white/40 text-sm">Current Balance</span>
                  <span className="text-[#00E2E5] font-bold text-sm">
                    {creditBalance} {creditKindName ? <span className="text-white/40 font-normal text-xs">({creditKindName})</span> : null}
                  </span>
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
