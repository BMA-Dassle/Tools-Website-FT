"use client";

import { useState, useEffect } from "react";
import QRCode from "qrcode";
import type { SmsBill } from "../data";

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

function cashTotal(bill: SmsBill): number {
  return bill.total.find(p => p.depositKind === 0)?.amount ?? 0;
}

export default function ConfirmationPage() {
  const [bill, setBill] = useState<SmsBill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [reservationCode, setReservationCode] = useState<string | null>(null);
  const [reservationNumber, setReservationNumber] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

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

        let processResult: { reservationCode?: string; reservationNumber?: string } | null = null;

        if (providerKind && data) {
          // BMI payment redirect — call payment/process
          const processRes = await fetch("/api/sms?endpoint=payment%2Fprocess", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paymentProviderKind: Number(providerKind),
              paymentMode: 0,
              extraData: { providerKind, data, transactionId: transactionId || id, orderId: orderId ?? id },
            }),
          });
          processResult = await processRes.json();
        } else if (transactionId || params.has("checkoutId")) {
          // Square payment link redirect — call payment/process with Square transaction
          const processRes = await fetch("/api/sms?endpoint=payment%2Fprocess", {
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
          processResult = await processRes.json();
        }

        if (processResult?.reservationCode) {
          setReservationCode(processResult.reservationCode);
        } else {
          // Fallback: construct from billId
          setReservationCode(`r${id}`);
        }
        if (processResult?.reservationNumber) {
          setReservationNumber(processResult.reservationNumber);
        }

        // Clean up URL params after processing
        if (transactionId || providerKind || params.has("checkoutId")) {
          if (!window.location.hostname.includes("localhost")) {
            window.history.replaceState({}, "", `/book/racing/confirmation`);
          } else {
            window.history.replaceState({}, "", `/book/racing/confirmation?billId=${id}`);
          }
        }

        // Set fallback reservation code if not already set from payment/process
        if (!reservationCode) {
          setReservationCode(`r${id}`);
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

  // Generate QR code when reservationCode is set
  useEffect(() => {
    if (!reservationCode) return;
    QRCode.toDataURL(reservationCode, { width: 200, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [reservationCode]);

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
