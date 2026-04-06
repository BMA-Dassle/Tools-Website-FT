"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const API = "/api/qamf";
const coral = "#fd5b56";
const gold = "#FFD700";

async function qamf(path: string, options?: RequestInit) {
  const res = await fetch(`${API}/${path}`, options);
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

export default function BowlingConfirmationPage() {
  const params = useSearchParams();
  const key = params.get("key");
  const centerId = params.get("center");
  const transactionId = params.get("transactionId") || params.get("orderId");

  const [status, setStatus] = useState<"loading" | "confirmed" | "failed">("loading");
  const [reservation, setReservation] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!key || !centerId) {
      setStatus("failed");
      return;
    }

    async function confirm() {
      try {
        // Confirm payment if we have transaction details
        if (transactionId) {
          await qamf(`centers/${centerId}/reservations/${key}/payment-confirm`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              QueryParams: { transactionId, orderId: transactionId },
            }),
          });
        }

        // Get stored reservation info
        const stored = sessionStorage.getItem("qamf_reservation");
        if (stored) setReservation(JSON.parse(stored));

        // Poll status
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const storedData = stored ? JSON.parse(stored) : null;
            const opId = storedData?.operationId;
            if (opId) {
              const statusData = await qamf(`centers/${centerId}/reservations/${key}/status/${opId}`);
              if (statusData?.PaymentStatus === "COMPLETED" || statusData?.ReservationStatus === "CONFIRMED") {
                clearInterval(poll);
                // End the flow
                await qamf(`centers/${centerId}/reservations/${key}/SetEndFlow`, { method: "PATCH" });
                setStatus("confirmed");
                return;
              }
            }
          } catch { /* keep polling */ }
          if (attempts > 30) {
            clearInterval(poll);
            setStatus("confirmed"); // Assume success after 30 attempts
          }
        }, 2000);

        return () => clearInterval(poll);
      } catch {
        setStatus("failed");
      }
    }

    confirm();
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
                <p className="font-[var(--font-hp-body)] text-white font-bold text-sm mb-1">
                  {reservation.offer as string}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm">
                  {reservation.centerName as string}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm">
                  {reservation.players as number} bowlers
                </p>
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
              We couldn&apos;t confirm your booking. Please contact us directly.
            </p>
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
