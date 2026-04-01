"use client";

import { useState, useEffect } from "react";
import QRCode from "qrcode";
import { bmiPost } from "../data";

export default function ConfirmationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [reservationCode, setReservationCode] = useState<string | null>(null);
  const [reservationNumber, setReservationNumber] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [raceName, setRaceName] = useState<string | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
  const [contactEmail, setContactEmail] = useState<string | null>(null);
  const [totalPaid, setTotalPaid] = useState<string | null>(null);
  const [racerCount, setRacerCount] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("orderId");
    setOrderId(id);
    setRaceName(params.get("race"));
    setContactName(params.get("name"));
    setContactEmail(params.get("email"));
    setTotalPaid(params.get("amount"));
    setRacerCount(params.get("qty"));
    if (!id) {
      setError("No booking ID found.");
      setLoading(false);
      return;
    }

    async function confirmAndLoad() {
      try {
        // Get the payment amount from URL (passed by OrderSummary)
        const amount = parseFloat(params.get("amount") || "0");

        // Call BMI payment/confirm to mark the order as paid
        const result = await bmiPost("payment/confirm", {
          id: crypto.randomUUID(),
          paymentTime: new Date().toISOString(),
          amount,
          orderId: Number(id),
        });

        if (result.reservationCode) {
          setReservationCode(result.reservationCode);
        } else {
          setReservationCode(`r${id}`);
        }
        if (result.reservationNumber) {
          setReservationNumber(result.reservationNumber);
        }

        // Clean up URL params
        window.history.replaceState({}, "", `/book/race/confirmation?orderId=${id}`);
      } catch {
        // Non-fatal — reservation may already be confirmed
        setReservationCode(`r${id}`);
      } finally {
        setLoading(false);
      }
    }

    confirmAndLoad();
  }, []);

  // Generate QR code
  useEffect(() => {
    if (!reservationCode) return;
    QRCode.toDataURL(reservationCode, { width: 200, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [reservationCode]);

  return (
    <div className="min-h-screen bg-[#000418] pt-24">
      <div className="max-w-lg mx-auto px-4 py-12">

        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 min-h-[300px]">
            <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Confirming your booking…</p>
          </div>
        )}

        {!loading && error && (
          <div className="text-center space-y-4">
            <p className="text-red-400">{error}</p>
            <a href="/book/race" className="text-[#00E2E5] underline text-sm">Book a race</a>
          </div>
        )}

        {!loading && orderId && (
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

            {/* QR Code */}
            {qrDataUrl && (
              <div className="flex flex-col items-center gap-3">
                <div className="rounded-xl bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="Reservation QR Code" width={180} height={180} />
                </div>
                <div className="text-center">
                  {reservationNumber && (
                    <p className="text-white font-bold text-lg">{reservationNumber}</p>
                  )}
                  <p className="text-white/40 text-xs">Show this QR code at check-in</p>
                </div>
              </div>
            )}

            {/* Booking details */}
            <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/8">
              {raceName && (
                <div className="p-4">
                  <p className="text-white/40 text-xs mb-1">Race</p>
                  <p className="text-white font-bold">{raceName}</p>
                </div>
              )}
              <div className="p-4 grid grid-cols-2 gap-4">
                {racerCount && (
                  <div>
                    <p className="text-white/40 text-xs mb-1">Racers</p>
                    <p className="text-white text-sm">{racerCount}</p>
                  </div>
                )}
                {totalPaid && (
                  <div>
                    <p className="text-white/40 text-xs mb-1">Total</p>
                    <p className="text-[#00E2E5] font-bold text-lg">${totalPaid}</p>
                  </div>
                )}
              </div>
              {contactName && (
                <div className="p-4">
                  <p className="text-white/40 text-xs mb-1">Contact</p>
                  <p className="text-white text-sm">{contactName}</p>
                  {contactEmail && <p className="text-white/50 text-xs">{contactEmail}</p>}
                </div>
              )}
              <div className="p-4">
                <p className="text-white/40 text-xs mb-1">Booking reference</p>
                <p className="text-white/70 text-sm font-mono">{orderId}</p>
              </div>
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
