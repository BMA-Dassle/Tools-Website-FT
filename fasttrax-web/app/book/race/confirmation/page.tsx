"use client";

import { useState, useEffect } from "react";
import QRCode from "qrcode";
import { bmiGet, bmiPost } from "../data";

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function checkinTime(iso: string) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - 30);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

interface Schedule {
  start: string;
  stop?: string;
  name?: string;
}

interface OrderLine {
  name: string;
  quantity: number;
  totalPrice: { amount: number; depositKind: number }[];
  scheduledTime?: { start: string; stop: string } | null;
  schedules?: Schedule[];
  productGroup: string;
}

interface OrderOverview {
  orderId: number;
  date?: string;
  subTotal: { amount: number; depositKind: number }[];
  total: { amount: number; depositKind: number }[];
  totalTax: { amount: number; depositKind: number }[];
  totalPaid: number;
  lines: OrderLine[];
  scheduleDays?: { date: string; schedules: Schedule[] }[];
}

export default function ConfirmationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderOverview | null>(null);
  const [reservationCode, setReservationCode] = useState<string | null>(null);
  const [reservationNumber, setReservationNumber] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("billId") || params.get("orderId");
    setOrderId(id);
    if (!id) {
      setError("No booking ID found.");
      setLoading(false);
      return;
    }

    async function confirmAndLoad() {
      try {
        // Fetch order overview BEFORE payment/confirm (BMI clears details after conversion)
        let overview: OrderOverview | null = null;
        try {
          overview = await bmiGet(`order/${id}/overview`);
          setOrder(overview);
        } catch {
          // Order may already be converted to reservation — use URL params as fallback
        }

        // Confirm payment
        const amount = parseFloat(params.get("amount") || "0");
        try {
          const result = await bmiPost("payment/confirm", {
            id: crypto.randomUUID(),
            paymentTime: new Date().toISOString(),
            amount,
            orderId: Number(id),
          });

          if (result.reservationCode) setReservationCode(result.reservationCode);
          if (result.reservationNumber) setReservationNumber(result.reservationNumber);
        } catch {
          // Non-fatal — may already be confirmed
        }

        // If order overview failed (already converted), build from URL params
        if (!overview) {
          const race = params.get("race");
          const qty = params.get("qty");
          const urlAmount = params.get("amount");
          if (race || urlAmount) {
            setOrder({
              orderId: Number(id),
              date: undefined,
              subTotal: [{ amount: parseFloat(urlAmount || "0"), depositKind: 0 }],
              total: [{ amount: parseFloat(urlAmount || "0"), depositKind: 0 }],
              totalTax: [{ amount: 0, depositKind: 0 }],
              totalPaid: 0,
              lines: race ? [{
                name: race,
                quantity: parseFloat(qty || "1"),
                totalPrice: [{ amount: parseFloat(urlAmount || "0"), depositKind: 0 }],
                productGroup: "Karting",
              }] : [],
            });
          }
        }

        if (!reservationCode) setReservationCode(`r${id}`);

        // Clean up URL
        // Clean URL — keep params on localhost for debugging
        if (!window.location.hostname.includes("localhost")) {
          window.history.replaceState({}, "", `/book/race/confirmation`);
        } else {
          window.history.replaceState({}, "", `/book/race/confirmation?billId=${id}`);
        }
      } catch {
        setError("Couldn't load booking details.");
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

  // Extract data from order
  const raceLine = order?.lines.find(l => l.productGroup === "Karting");
  const start = raceLine?.scheduledTime?.start
    || raceLine?.schedules?.[0]?.start
    || order?.scheduleDays?.[0]?.schedules?.[0]?.start
    || order?.date
    || null;
  const cashTotal = order?.total.find(t => t.depositKind === 0)?.amount;

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

            {/* Check-in time alert */}
            {start && (
              <div className="rounded-xl border-2 border-red-500/50 bg-red-500/10 p-4 text-center">
                <p className="text-red-400 text-xs font-bold uppercase tracking-wider mb-1">Check In By</p>
                <p className="text-white font-display text-2xl uppercase tracking-widest">
                  {checkinTime(start)}
                </p>
                <p className="text-white/50 text-xs mt-1">
                  Guest Services, 2nd Floor — 30 minutes before your heat
                </p>
              </div>
            )}

            {/* Booking details from order/overview */}
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
              <div className="p-4 grid grid-cols-2 gap-4">
                {raceLine && (
                  <div>
                    <p className="text-white/40 text-xs mb-1">Racers</p>
                    <p className="text-white text-sm">{raceLine.quantity}</p>
                  </div>
                )}
                {cashTotal !== undefined && (
                  <div>
                    <p className="text-white/40 text-xs mb-1">Total</p>
                    <p className="text-[#00E2E5] font-bold text-lg">${cashTotal.toFixed(2)}</p>
                  </div>
                )}
              </div>
              <div className="p-4">
                <p className="text-white/40 text-xs mb-1">Booking reference</p>
                <p className="text-white/70 text-sm font-mono">{orderId}</p>
              </div>
            </div>

            {/* Reminders */}
            <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/50 space-y-2">
              <p className="font-semibold text-white/70 mb-2">Before you arrive</p>
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
