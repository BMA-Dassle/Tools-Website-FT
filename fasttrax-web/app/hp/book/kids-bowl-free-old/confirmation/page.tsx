"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";

/**
 * KBF reservation confirmation page.
 *
 * Reads `?key=...&center=...` from the URL (set by the reserve
 * route). Fetches the reservation summary from QAMF for display
 * and shows arrival instructions.
 *
 * Lightweight clone of `app/hp/book/bowling/confirmation/page.tsx` —
 * kept inline rather than abstracted because the bowling
 * confirmation has flow-specific concerns (BMI add-ons, Square
 * post-payment) that don't apply here.
 */

const CORAL = "#fd5b56";
const NAVY = "#123075";
const GOLD = "#FFD700";
const BG = "#0a1628";

const CENTER_NAME: Record<string, string> = {
  "9172": "HeadPinz Fort Myers",
  "3148": "HeadPinz Naples",
};

const CENTER_PHONE: Record<string, string> = {
  "9172": "(239) 302-2155",
  "3148": "(239) 455-3755",
};

interface QamfReservationDetail {
  ReservationKey?: string;
  Status?: string;
  DateFrom?: string;
  WebOfferName?: string;
  Players?: { Name?: string; ShoeSize?: string | null; WantBumpers?: boolean }[];
  Total?: number;
}

export default function KbfConfirmationPage() {
  const sp = useSearchParams();
  const reservationKey = sp.get("key") ?? "";
  const centerId = sp.get("center") ?? "";

  const [data, setData] = useState<QamfReservationDetail | null>(null);
  const [fetchError, setFetchError] = useState(false);

  // Bad-params check is derived state — no effect needed.
  const missingParams = !reservationKey || !centerId;
  const loadFailed = missingParams || fetchError;

  useEffect(() => {
    if (missingParams) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/qamf/centers/${centerId}/reservations/${encodeURIComponent(reservationKey)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setFetchError(true);
          return;
        }
        const json = (await res.json()) as QamfReservationDetail;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setFetchError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservationKey, centerId, missingParams]);

  const dateLabel = data?.DateFrom
    ? new Date(data.DateFrom).toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      <main className="pt-28 sm:pt-36 pb-20 px-4">
        <div className="max-w-2xl mx-auto">
          <div
            className="rounded-2xl border p-6 sm:p-8 mb-5"
            style={{
              backgroundColor: "rgba(253,91,86,0.08)",
              borderColor: `${CORAL}55`,
            }}
          >
            <div
              className="uppercase font-bold mb-2"
              style={{ color: CORAL, fontSize: "11px", letterSpacing: "3px" }}
            >
              Confirmed
            </div>
            <h1
              className="font-heading font-black uppercase italic text-white mb-2"
              style={{ fontSize: "clamp(28px, 5vw, 40px)", lineHeight: 1.05 }}
            >
              You&apos;re booked!
            </h1>
            <p className="text-white/80 text-sm">
              Show this confirmation (or your Kids Bowl Free coupon email) at
              the front desk. Your lane is held until 5 minutes after start
              time.
            </p>
          </div>

          {loadFailed && (
            <div className="rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-100">
              We couldn&apos;t fetch the reservation details right now — but
              your lane is held. Bring your KBF coupon to{" "}
              {CENTER_NAME[centerId] ?? "the center"} and the front desk will
              find it.
            </div>
          )}

          {data && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-3">
              <Row label="Reservation" value={reservationKey} mono />
              <Row label="Center" value={CENTER_NAME[centerId] ?? centerId} />
              <Row label="When" value={dateLabel || "—"} />
              {data.WebOfferName && <Row label="Tariff" value={data.WebOfferName} />}
              {data.Players && data.Players.length > 0 && (
                <div>
                  <div className="text-white/50 text-xs uppercase tracking-wider mb-1">
                    Bowlers
                  </div>
                  <ul className="text-sm text-white/85 space-y-0.5">
                    {data.Players.map((p, i) => (
                      <li key={i}>
                        {p.Name || `Bowler ${i + 1}`}
                        {p.ShoeSize ? ` — ${p.ShoeSize}` : ""}
                        {p.WantBumpers ? " · bumpers" : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {typeof data.Total === "number" && (
                <Row label="Total" value={data.Total === 0 ? "Free" : `$${data.Total.toFixed(2)}`} />
              )}
            </div>
          )}

          <div
            className="mt-5 rounded-xl border px-4 py-4"
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
            <p className="text-white/75 text-xs">
              Call the center at least 1 hour before your start time:{" "}
              <a
                className="underline hover:text-white"
                href={`tel:${(CENTER_PHONE[centerId] ?? "").replace(/\D/g, "")}`}
              >
                {CENTER_PHONE[centerId] ?? "(239) 302-2155"}
              </a>
            </p>
          </div>

          <div className="mt-6 flex flex-col sm:flex-row gap-2">
            <Link
              href="/hp/kids-bowl-free"
              className="flex-1 text-center rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/80 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
            >
              Back to Kids Bowl Free
            </Link>
            <Link
              href="/hp/book"
              className="flex-1 text-center rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01]"
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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-white/50">{label}</span>
      <span
        className={`text-white text-right ${mono ? "font-mono" : ""}`}
        style={mono ? { letterSpacing: "0.5px" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}
