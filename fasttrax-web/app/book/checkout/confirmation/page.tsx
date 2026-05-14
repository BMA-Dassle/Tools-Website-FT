"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import BrandNav from "@/components/BrandNav";

/**
 * Unified checkout confirmation page.
 *
 * checkout/v2 handles ALL confirmation (QAMF + BMI + Square + Neon).
 * This page just displays the result — NO re-confirmation needed.
 *
 * Primary data source: `sessionStorage.checkoutConfirmation` (JSON saved
 * by the checkout page before redirecting here).
 *
 * Fallback: if sessionStorage is empty (e.g. page refreshed), show a
 * generic "booking confirmed" message. The booking is already confirmed
 * at this point — the customer just loses the detailed summary.
 */

interface ConfirmationData {
  neonId?: number;
  neonIds?: number[];
  checkoutGroupId?: string | null;
  bmiBillId?: string | null;
  bmiReservationNumber?: string | null;
  bmiConfirmed?: boolean;
  qamfReservationId?: string | null;
  qamfConfirmed?: boolean;
  depositPaidCents?: number;
  totalCents?: number;
  bowling?: {
    experienceName: string;
    timeLabel: string;
    bookedAt?: string;
    locationKey?: string;
    kind?: string;
    players: Array<{ name?: string; shoeSize?: string | null }> | number;
    totalCents: number;
    depositCents?: number;
    lineItems?: Array<{ name: string; quantity: string }>;
  } | null;
  attractions?: {
    name: string;
    quantity: number;
    date: string;
    time: string | null;
  }[];
  guestName?: string | null;
  guestEmail?: string | null;
}

const LOCATION_DISPLAY: Record<string, { name: string; address: string }> = {
  fasttrax: { name: "FastTrax Indoor Karting", address: "1255 Piper Blvd, Naples, FL 34110" },
  headpinz: { name: "HeadPinz Entertainment", address: "14513 Global Pkwy, Fort Myers, FL 33913" },
  naples: { name: "HeadPinz Naples", address: "4 Naples Blvd, Naples, FL 34104" },
};

function formatTime(iso: string) {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return "";
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default function CheckoutConfirmation() {
  const [data, setData] = useState<ConfirmationData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("checkoutConfirmation");
      if (raw) {
        setData(JSON.parse(raw));
        // Clean up — one-time read
        sessionStorage.removeItem("checkoutConfirmation");
      }
    } catch { /* fallback to generic */ }
    setLoaded(true);

    // Strip query params from URL
    if (!window.location.hostname.includes("localhost")) {
      window.history.replaceState({}, "", "/book/checkout/confirmation");
    }
  }, []);

  if (!loaded) {
    return (
      <div className="min-h-screen bg-[#000418]">
        <BrandNav />
        <div className="flex justify-center py-32">
          <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  const hasBowling = !!data?.bowling;
  const hasAttractions = !!data?.attractions?.length;
  const depositDollars = data?.depositPaidCents ? (data.depositPaidCents / 100).toFixed(2) : null;
  const totalDollars = data?.totalCents ? (data.totalCents / 100).toFixed(2) : null;

  // Resolve bowling details
  const bowlingPlayerCount = data?.bowling
    ? (Array.isArray(data.bowling.players) ? data.bowling.players.length : (data.bowling.players || 1))
    : 0;
  const bowlingPlayerNames = data?.bowling && Array.isArray(data.bowling.players)
    ? data.bowling.players.filter((p) => p.name).map((p) => p.name!)
    : [];
  const bowlingLocation = data?.bowling?.locationKey
    ? LOCATION_DISPLAY[data.bowling.locationKey]
    : null;

  return (
    <div className="min-h-screen bg-[#000418]">
      <BrandNav />

      <div className="max-w-md mx-auto px-4 pt-32 sm:pt-36 pb-16">
        <div className="space-y-6 text-center">

          {/* ── Success icon ─────────────────────────────────── */}
          <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center mx-auto">
            <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h1 className="text-3xl font-display uppercase tracking-widest text-white">
            You&apos;re All Set!
          </h1>
          <p className="text-white/50 text-sm">
            Your booking is confirmed.{" "}
            {data?.guestEmail && <>A confirmation email has been sent to <span className="text-white/70">{data.guestEmail}</span>.</>}
          </p>

          {/* ── Booking details ───────────────────────────────── */}
          {data && (hasBowling || hasAttractions) && (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-left space-y-4">

              {/* Bowling */}
              {hasBowling && data.bowling && (
                <div className="space-y-2">
                  {hasAttractions && (
                    <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider mb-2">
                      🎳 Bowling
                    </p>
                  )}
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-white text-sm font-semibold">{data.bowling.experienceName}</p>
                      {data.bowling.bookedAt && (
                        <p className="text-white/40 text-xs">
                          {formatDate(data.bowling.bookedAt.split("T")[0])} · {data.bowling.timeLabel}
                        </p>
                      )}
                      {!data.bowling.bookedAt && (
                        <p className="text-white/40 text-xs">{data.bowling.timeLabel}</p>
                      )}
                      <p className="text-white/30 text-xs">
                        {bowlingPlayerCount} player{bowlingPlayerCount !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <span className="text-white/50 text-sm">
                      ${(data.bowling.totalCents / 100).toFixed(2)}
                    </span>
                  </div>

                  {/* Player names */}
                  {bowlingPlayerNames.length > 0 && (
                    <div className="pl-2 border-l-2 border-white/8">
                      {bowlingPlayerNames.map((name, i) => (
                        <p key={i} className="text-white/30 text-xs">{name}</p>
                      ))}
                    </div>
                  )}

                  {/* Line items (shoes, add-ons, etc.) */}
                  {data.bowling.lineItems && data.bowling.lineItems.length > 1 && (
                    <div className="mt-1 space-y-0.5">
                      {data.bowling.lineItems.map((li, i) => (
                        <div key={i} className="flex justify-between text-xs text-white/25">
                          <span>{li.name}</span>
                          {parseInt(li.quantity) > 1 && <span>x{li.quantity}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Location */}
                  {bowlingLocation && (
                    <div className="mt-1">
                      <p className="text-white/30 text-xs">{bowlingLocation.name}</p>
                      <p className="text-white/20 text-[10px]">{bowlingLocation.address}</p>
                    </div>
                  )}
                </div>
              )}

              {hasBowling && hasAttractions && <div className="border-t border-white/8" />}

              {/* Attractions / Racing */}
              {hasAttractions && data.attractions && (
                <div>
                  {hasBowling && (
                    <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider mb-2">
                      🎯 Attractions
                    </p>
                  )}
                  {data.attractions.map((item, i) => (
                    <div key={i} className="flex justify-between items-start mb-2 last:mb-0">
                      <div>
                        <p className="text-white text-sm font-semibold">{item.name}</p>
                        {item.date && (
                          <p className="text-white/40 text-xs">
                            {formatDate(item.date)}
                            {item.time ? ` · ${formatTime(item.time)}` : ""}
                          </p>
                        )}
                        {item.quantity > 1 && (
                          <p className="text-white/30 text-xs">x{item.quantity}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Totals */}
              {(depositDollars || totalDollars) && (
                <>
                  <div className="border-t border-white/8" />
                  <div className="space-y-1">
                    {depositDollars && (
                      <div className="flex justify-between text-sm">
                        <span className="text-white/50">Deposit paid</span>
                        <span className="text-[#00E2E5] font-bold">${depositDollars}</span>
                      </div>
                    )}
                    {totalDollars && totalDollars !== depositDollars && (
                      <div className="flex justify-between text-xs">
                        <span className="text-white/30">Remaining balance</span>
                        <span className="text-white/40">
                          ${((data!.totalCents! - (data!.depositPaidCents || 0)) / 100).toFixed(2)} due day-of
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Reservation references ───────────────────────── */}
          {(data?.bmiReservationNumber || data?.qamfReservationId) && (
            <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 text-left">
              <p className="text-white/30 text-xs font-bold uppercase tracking-wider mb-2">
                Reference
              </p>
              {data.bmiReservationNumber && (
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-white/40">Reservation #</span>
                  <span className="font-mono text-[#00E2E5]">{data.bmiReservationNumber}</span>
                </div>
              )}
              {data.qamfReservationId && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/40">Bowling Ref</span>
                  <span className="font-mono text-[#00E2E5]">{data.qamfReservationId}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Not confirmed warning (edge case) ────────────── */}
          {data && (!data.bmiConfirmed || !data.qamfConfirmed) && (data.bmiConfirmed !== undefined || data.qamfConfirmed !== undefined) && (
            (() => {
              const issues: string[] = [];
              if (data.bmiConfirmed === false) issues.push("attraction reservation");
              if (data.qamfConfirmed === false && data.qamfReservationId) issues.push("bowling reservation");
              if (!issues.length) return null;
              return (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-left">
                  <p className="text-amber-400 text-xs">
                    ⚠️ Your {issues.join(" and ")} confirmation is still processing. Your payment has been received — our team will follow up if any action is needed.
                  </p>
                </div>
              );
            })()
          )}

          {/* ── Actions ──────────────────────────────────────── */}
          <div className="flex flex-col gap-3 pt-4">
            <Link
              href="/book"
              className="w-full py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] font-bold text-sm hover:bg-white transition-colors text-center shadow-lg shadow-[#00E2E5]/25"
            >
              Book More Activities
            </Link>
            <Link
              href="/"
              className="w-full py-3 rounded-xl border border-white/15 text-white/60 hover:border-white/30 hover:text-white text-sm font-semibold transition-colors text-center"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
