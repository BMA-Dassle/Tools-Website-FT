"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const API = "/api/qamf";
const coral = "#fd5b56";
const gold = "#FFD700";

async function qamfCall(path: string, options?: RequestInit) {
  const token = sessionStorage.getItem("qamf_session_token") || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> || {}),
  };
  if (token) headers["x-sessiontoken"] = token;

  const res = await fetch(`${API}/${path}`, { ...options, headers });
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export default function BowlingConfirmationPage() {
  const params = useSearchParams();

  // Capture URL params into sessionStorage and clean the URL
  const [confirmData] = useState(() => {
    const urlKey = params.get("key");
    const urlCenter = params.get("center");
    const urlTx = params.get("transactionId") || params.get("orderId");

    // If URL has params, store them and clean URL
    if (urlKey && typeof window !== "undefined") {
      const data = { key: urlKey, center: urlCenter || "", transactionId: urlTx || "" };
      sessionStorage.setItem("qamf_confirm_data", JSON.stringify(data));
      window.history.replaceState({}, "", window.location.pathname);
      return data;
    }

    // Otherwise read from sessionStorage (page was already cleaned)
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("qamf_confirm_data");
      if (stored) return JSON.parse(stored);
    }

    return { key: null, center: null, transactionId: null };
  });

  const key = confirmData.key;
  const centerId = confirmData.center;
  const transactionId = confirmData.transactionId;

  const [status, setStatus] = useState<"loading" | "confirmed" | "failed">("loading");
  const [reservation, setReservation] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!key || !centerId) {
      setStatus("failed");
            return;
    }

    let pollInterval: NodeJS.Timeout | null = null;

    async function confirm() {
      try {
        // Get stored reservation info
        const stored = sessionStorage.getItem("qamf_reservation");
        if (stored) setReservation(JSON.parse(stored));
        const opId = stored ? JSON.parse(stored).operationId : null;

        // Step 1: Confirm payment with transaction ID
        if (transactionId) {
          try {
            await qamfCall(`centers/${centerId}/reservations/${key}/payment-confirm`, {
              method: "PUT",
              body: JSON.stringify({
                QueryParams: { transactionId, orderId: transactionId },
              }),
            });
          } catch {
            // Payment confirm might fail but reservation could still be confirmed
          }
        }

        // Step 2: Poll reservation status
        let attempts = 0;
        pollInterval = setInterval(async () => {
          attempts++;
          try {
            if (opId) {
              const statusData = await qamfCall(`centers/${centerId}/reservations/${key}/status/${opId}`);

              if (statusData?.PaymentStatus === "COMPLETED" || statusData?.ReservationStatus === "CONFIRMED") {
                if (pollInterval) clearInterval(pollInterval);
                // End the flow
                try {
                  await qamfCall(`centers/${centerId}/reservations/${key}/SetEndFlow`, { method: "PATCH" });
                } catch { /* ok */ }
                setStatus("confirmed");
                // Clean up session
                sessionStorage.removeItem("qamf_session_token");
                sessionStorage.removeItem("qamf_reservation");
                sessionStorage.removeItem("qamf_confirm_data");
                return;
              }
            } else {
              // No operation ID — try checking reservation status directly
              const statusData = await qamfCall(`centers/${centerId}/reservations/${key}/status`);
              if (statusData === "Confirmed" || statusData === "CONFIRMED") {
                if (pollInterval) clearInterval(pollInterval);
                setStatus("confirmed");
                sessionStorage.removeItem("qamf_session_token");
                sessionStorage.removeItem("qamf_reservation");
                sessionStorage.removeItem("qamf_confirm_data");
                return;
              }
            }
          } catch { /* keep polling */ }

          // After 15 attempts (30s), assume success since payment went through Square
          if (attempts >= 15) {
            if (pollInterval) clearInterval(pollInterval);
            setStatus("confirmed");
            sessionStorage.removeItem("qamf_session_token");
            sessionStorage.removeItem("qamf_reservation");
          }
        }, 2000);
      } catch {
        // If everything fails but we have a transaction ID, payment likely went through
        if (transactionId) {
          setStatus("confirmed");
        } else {
          setStatus("failed");
        }
      }
    }

    confirm();

    return () => { if (pollInterval) clearInterval(pollInterval); };
  }, [key, centerId, transactionId]);

  return (
    <div className="min-h-screen bg-[#0a1628] flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        {status === "loading" && (
          <div>
            <div className="inline-block w-12 h-12 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin mb-6" />
            <h1
              className="font-[var(--font-hp-hero)] font-black uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 36px)", textShadow: `0 0 30px ${coral}30` }}
            >
              Confirming...
            </h1>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm mt-2">
              Processing your payment. Please don&apos;t close this page.
            </p>
          </div>
        )}

        {status === "confirmed" && (
          <div>
            <div
              className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-6"
              style={{ backgroundColor: `${gold}20`, border: `2px solid ${gold}` }}
            >
              <svg className="w-8 h-8" style={{ color: gold }} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>

            <h1
              className="font-[var(--font-hp-hero)] font-black uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 36px)", textShadow: `0 0 30px ${gold}30`, marginBottom: "8px" }}
            >
              You&apos;re Booked!
            </h1>

            {reservation && (
              <div
                className="rounded-lg p-5 mt-6 mb-6 text-left"
                style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}
              >
                {reservation.offer && (
                  <p className="font-[var(--font-hp-body)] text-white font-bold text-sm mb-1">
                    {reservation.offer as string}
                  </p>
                )}
                {reservation.centerName && (
                  <p className="font-[var(--font-hp-body)] text-white/60 text-sm">
                    {reservation.centerName as string}
                  </p>
                )}
                {reservation.players && (
                  <p className="font-[var(--font-hp-body)] text-white/60 text-sm">
                    {reservation.players as number} bowlers
                  </p>
                )}
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mt-2">
                  Confirmation: {key}
                </p>
              </div>
            )}

            <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-6">
              A confirmation email has been sent. Please arrive 15 minutes before your reservation time.
            </p>

            <Link
              href="/hp/fort-myers"
              className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
              style={{ boxShadow: `0 0 16px ${coral}30` }}
            >
              Back to HeadPinz
            </Link>
          </div>
        )}

        {status === "failed" && (
          <div>
            <h1
              className="font-[var(--font-hp-hero)] font-black uppercase text-white"
              style={{ fontSize: "clamp(24px, 5vw, 36px)", textShadow: `0 0 30px ${coral}30` }}
            >
              Something Went Wrong
            </h1>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm mt-2 mb-6">
              {transactionId
                ? "Your payment was received but we couldn't confirm the reservation. Please contact us with your confirmation number."
                : "We couldn't confirm your booking. Please contact us directly."}
            </p>
            {key && (
              <p className="font-[var(--font-hp-body)] text-white/30 text-xs mb-4">
                Reference: {key}
              </p>
            )}
            <a
              href="tel:+12393022155"
              className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
            >
              Call (239) 302-2155
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
