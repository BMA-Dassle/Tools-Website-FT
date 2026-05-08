"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import type { BowlingReservation, ReservationLine } from "@/lib/bowling-db";

/**
 * Open Bowling V2 confirmation page.
 *
 * URL params (set by /api/bowling/v2/reserve redirect):
 *   neonId      — bowling_reservations.id  (may be "0" if Neon insert failed)
 *   qamfId      — QAMF reservation UUID    (canonical booking reference)
 *   centerId    — "9172" | "3148"
 *   depositPaid — cents charged at booking (integer string)
 *   remaining   — cents due at center      (integer string)
 *
 * Parallel deployment — moves to /hp/book/bowling/confirmation/ at PR 2 cutover.
 */

const CORAL = "#fd5b56";
const NAVY = "#123075";
const GOLD = "#FFD700";
const BG = "#0a1628";

const CENTER_NAME: Record<string, string> = {
  "9172": "HeadPinz Fort Myers",
  "3148": "HeadPinz Naples",
};

const CENTER_ADDRESS: Record<string, string> = {
  "9172": "14513 Global Pkwy, Fort Myers",
  "3148": "4360 Thomasson Dr, Naples",
};

const CENTER_PHONE: Record<string, string> = {
  "9172": "(239) 302-2155",
  "3148": "(239) 455-3755",
};

type ReservationWithLines = BowlingReservation & {
  lines: (ReservationLine & { id: number; reservationId: number })[];
};

// ── Helpers ────────────────────────────────────────────────────────

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBookedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

// ── Sub-components ─────────────────────────────────────────────────

function Row({ label, value, mono, green }: { label: string; value: string; mono?: boolean; green?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-white/50 shrink-0">{label}</span>
      <span
        className={`text-right ${mono ? "font-mono" : ""} ${green ? "text-green-400 font-semibold" : "text-white"}`}
        style={mono ? { letterSpacing: "0.4px" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function DividerLine() {
  return <div className="border-t border-white/10 my-2" />;
}

// ── Main content ───────────────────────────────────────────────────

function ConfirmationContent() {
  const sp = useSearchParams();
  const neonIdStr = sp.get("neonId") ?? "0";
  const qamfId = sp.get("qamfId") ?? "";
  const centerId = sp.get("centerId") ?? "";
  const depositPaidCents = parseInt(sp.get("depositPaid") ?? "0", 10);
  const remainingCents = parseInt(sp.get("remaining") ?? "0", 10);

  const neonId = parseInt(neonIdStr, 10);
  const hasNeonRecord = !isNaN(neonId) && neonId > 0;

  const [reservation, setReservation] = useState<ReservationWithLines | null>(null);
  const [fetchError, setFetchError] = useState(false);

  const centerName = CENTER_NAME[centerId] ?? "HeadPinz";
  const centerPhone = CENTER_PHONE[centerId] ?? "(239) 302-2155";
  const centerAddress = CENTER_ADDRESS[centerId] ?? "";

  useEffect(() => {
    if (!hasNeonRecord) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setFetchError(true);
          return;
        }
        const json = (await res.json()) as ReservationWithLines;
        if (!cancelled) setReservation(json);
      } catch {
        if (!cancelled) setFetchError(true);
      }
    })();

    return () => { cancelled = true; };
  }, [neonId, hasNeonRecord]);

  const displayDepositPaid = reservation ? reservation.depositCents : depositPaidCents;
  const displayTotal = reservation ? reservation.totalCents : displayDepositPaid + remainingCents;
  const displayRemaining = displayTotal - displayDepositPaid;

  const dateLabel = reservation?.bookedAt ? formatBookedAt(reservation.bookedAt) : "";
  const lines = reservation?.lines ?? [];

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      <main className="pt-28 sm:pt-36 pb-24 px-4">
        <div className="max-w-2xl mx-auto space-y-4">

          {/* ── Hero card ── */}
          <div
            className="rounded-2xl border p-6 sm:p-8"
            style={{
              backgroundColor: "rgba(253,91,86,0.08)",
              borderColor: `${CORAL}55`,
            }}
          >
            <div
              className="uppercase font-bold mb-2"
              style={{ color: CORAL, fontSize: "11px", letterSpacing: "3px" }}
            >
              Open Bowling · Confirmed
            </div>
            <h1
              className="font-heading font-black uppercase italic text-white mb-2"
              style={{ fontSize: "clamp(28px, 5vw, 40px)", lineHeight: 1.05 }}
            >
              You&apos;re booked!
            </h1>
            <p className="text-white/70 text-sm leading-relaxed">
              Your deposit has been charged and your lane is reserved.
              Bring this confirmation when you arrive.
            </p>
          </div>

          {/* ── Fetch-failed warning ── */}
          {(fetchError || !hasNeonRecord) && (
            <div className="rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-100">
              {!hasNeonRecord
                ? "Your booking is confirmed — we couldn't save the full record, but your lane is held."
                : "We couldn't load your full booking details right now — but your lane is held."}{" "}
              Please show your booking reference at the front desk.
            </div>
          )}

          {/* ── Booking details card ── */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-3">
            {qamfId && <Row label="Booking ref" value={qamfId} mono />}
            <Row label="Center" value={centerName} />
            {centerAddress && <Row label="Address" value={centerAddress} />}
            {dateLabel && <Row label="When" value={dateLabel} />}
            {reservation?.playerCount != null && (
              <Row label="Bowlers" value={String(reservation.playerCount)} />
            )}
            {reservation?.guestName && <Row label="Guest" value={reservation.guestName} />}

            {/* Line items */}
            {lines.length > 0 && (
              <>
                <DividerLine />
                <div>
                  <div
                    className="uppercase font-bold mb-2"
                    style={{ color: "rgba(255,255,255,0.35)", fontSize: "10px", letterSpacing: "2.5px" }}
                  >
                    Order
                  </div>
                  <div className="space-y-1.5">
                    {lines.map((line, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-white/75">
                          {line.label}
                          {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                        </span>
                        <span className="text-white">
                          {line.unitPriceCents === 0
                            ? "Free"
                            : centsToDollars(line.unitPriceCents * line.quantity)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Payment summary */}
            {displayDepositPaid > 0 && (
              <>
                <DividerLine />
                <div className="space-y-1.5">
                  {displayTotal > 0 && (
                    <Row label="Order total" value={centsToDollars(displayTotal)} />
                  )}
                  <Row label="Paid at booking" value={centsToDollars(displayDepositPaid)} green />
                  {displayRemaining > 0 && (
                    <Row label="Balance due at center" value={centsToDollars(displayRemaining)} />
                  )}
                  {displayRemaining === 0 && (
                    <Row label="Balance due at center" value="Paid in full" />
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Arrival card ── */}
          <div
            className="rounded-xl border px-5 py-4 space-y-2"
            style={{
              backgroundColor: "rgba(18,48,117,0.35)",
              borderColor: `${NAVY}99`,
            }}
          >
            <div
              className="uppercase font-bold"
              style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
            >
              When you arrive
            </div>
            <ul className="text-white/75 text-sm space-y-1 list-disc list-inside">
              <li>Show this confirmation at the front desk.</li>
              <li>Rental shoes are available at the front counter.</li>
              <li>Your lane is held until 10 minutes after start time.</li>
              {displayRemaining > 0 && (
                <li>
                  Your remaining balance of{" "}
                  <span className="text-white font-semibold">{centsToDollars(displayRemaining)}</span>{" "}
                  is due at the center.
                </li>
              )}
            </ul>
          </div>

          {/* ── Cancel card ── */}
          <div
            className="rounded-xl border px-4 py-4"
            style={{
              backgroundColor: "rgba(255,215,0,0.06)",
              borderColor: "rgba(255,215,0,0.35)",
            }}
          >
            <div
              className="uppercase font-bold mb-1"
              style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
            >
              Need to cancel or change?
            </div>
            <p className="text-white/75 text-xs leading-relaxed">
              Call {centerName} at least 2 hours before your start time:{" "}
              <a
                className="underline hover:text-white transition-colors"
                href={`tel:${centerPhone.replace(/\D/g, "")}`}
              >
                {centerPhone}
              </a>
            </p>
          </div>

          {/* ── Nav ── */}
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <Link
              href="/hp/book/open-bowling"
              className="flex-1 text-center rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
            >
              Book another lane
            </Link>
            <Link
              href="/hp/book"
              className="flex-1 text-center rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{
                backgroundColor: NAVY,
                border: `1.78px solid ${GOLD}40`,
              }}
            >
              Book something else
            </Link>
          </div>

        </div>
      </main>
    </div>
  );
}

// ── Page wrapper ───────────────────────────────────────────────────

export default function OpenBowlingConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div style={{ backgroundColor: BG }} className="min-h-screen">
          <HeadPinzNav />
          <main className="pt-28 pb-20 px-4">
            <div className="max-w-2xl mx-auto">
              <div className="animate-pulse space-y-4">
                <div className="h-32 rounded-2xl bg-white/5" />
                <div className="h-48 rounded-2xl bg-white/5" />
              </div>
            </div>
          </main>
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}
