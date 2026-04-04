"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import QRCode from "qrcode";
import { bmiGet, bmiPost } from "../data";
import { trackBookingComplete } from "@/lib/analytics";
import { useTrackStatus } from "@/hooks/useTrackStatus";

// Parse time string as local (API returns local ET times without Z suffix)
function parseLocal(iso: string): Date {
  // Strip Z suffix if present — these are local times
  const clean = iso.replace(/Z$/, "");
  // Parse as YYYY-MM-DDTHH:MM:SS manually to avoid UTC interpretation
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatTime(iso: string) {
  return parseLocal(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function checkinTime(iso: string) {
  const d = parseLocal(iso);
  d.setMinutes(d.getMinutes() - 30);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function fiveMinBefore(iso: string) {
  const d = parseLocal(iso);
  d.setMinutes(d.getMinutes() - 5);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string) {
  return parseLocal(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

interface RacerConfirmation {
  billId: string;
  racerName: string;
  resNumber: string;
  resCode: string;
  personId?: string;
  raceName?: string;
  heatTime?: string;
  waiverValid?: boolean;
  waiverExpiry?: string;
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
  /** Per-racer confirmation results with waiver + schedule data */
  const [confirmations, setConfirmations] = useState<RacerConfirmation[]>([]);
  /** Waiver fast-track: all returning racers have valid waivers */
  const [waiverStatus, setWaiverStatus] = useState<"checking" | "all-valid" | "not-valid" | "not-returning">("checking");
  /** Per-racer QR codes */
  const [racerQrCodes, setRacerQrCodes] = useState<Record<string, string>>({});
  const confirmStarted = useRef(false);

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
      if (confirmStarted.current) return;
      confirmStarted.current = true;

      try {
        // Fetch booking details from Redis (primary) or localStorage (fallback)
        let details: Record<string, string> | null = null;
        try {
          const storeRes = await fetch(`/api/booking-store?billId=${id}`);
          if (storeRes.ok) details = await storeRes.json();
        } catch { /* Redis unavailable */ }
        if (!details) {
          const stored = localStorage.getItem(`booking_${id}`);
          if (stored) details = JSON.parse(stored);
        }

        const amount = details?.amount ? parseFloat(details.amount) : 0;

        // Try order overview (may still be available before BMI converts it)
        let overview: OrderOverview | null = null;
        try {
          overview = await bmiGet(`order/${id}/overview`);
          if (overview?.lines?.length && overview.lines.length > 0) {
            setOrder(overview);
          }
        } catch {
          // Order already converted to reservation
        }

        // Confirm payment on ALL bills (multi-bill for per-person credits)
        const billIdsParam = params.get("billIds");
        const racerNamesParam = params.get("racerNames");
        const allBillIds = billIdsParam ? billIdsParam.split(",") : [id!];
        const racerNames = racerNamesParam ? racerNamesParam.split(",").map(decodeURIComponent) : [];
        const personIdsParam = params.get("personIds");
        const personIds = personIdsParam ? personIdsParam.split(",") : [];
        const allConfirmations: RacerConfirmation[] = [];

        try {
          for (let i = 0; i < allBillIds.length; i++) {
            const bid = allBillIds[i];
            const racerName = racerNames[i] || `Racer ${i + 1}`;
            const pid = personIds[i] || undefined;

            // Get bill overview for race details
            let raceName = "";
            let heatTime = "";
            let billAmount = amount;
            try {
              const ovRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${bid}`);
              const ov = await ovRes.json();
              if (allBillIds.length > 1) {
                const cashT = ov.total?.find((t: { depositKind: number }) => t.depositKind === 0);
                billAmount = cashT?.amount ?? 0;
              }
              // Extract race name and heat time from first karting line
              const raceLine = ov.lines?.find((l: { productGroup?: string }) => l.productGroup === "Karting" || l.productGroup === "Race");
              if (raceLine) {
                raceName = raceLine.name || "";
                heatTime = raceLine.scheduledTime?.start || raceLine.schedules?.[0]?.start || "";
              }
            } catch { /* use defaults */ }

            const depositKind = billAmount === 0 ? 2 : 0;
            const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":${billAmount},"orderId":${bid},"depositKind":${depositKind}}`;
            const qs = new URLSearchParams({ endpoint: "payment/confirm" });
            const confirmRes = await fetch(`/api/bmi?${qs.toString()}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: confirmBody,
            });
            const result = await confirmRes.json();
            const resNum = result.reservationNumber || "";
            const resCode = String(result.reservationCode || `r${bid}`);

            // Always add to confirmations (even if payment/confirm failed) so waiver is checked
            allConfirmations.push({
              billId: bid,
              racerName: racerName || `Racer ${i + 1}`,
              resNumber: resNum,
              resCode,
              personId: pid,
              raceName,
              heatTime,
            });

            if (i === 0) {
              if (resCode) setReservationCode(resCode);
              if (resNum) setReservationNumber(resNum);
            }
          }
        } catch {
          // Non-fatal — may already be confirmed
        }

        // Check waivers for returning racers
        if (personIds.length > 0) {
          const waiverChecks = await Promise.all(
            allConfirmations.filter(c => c.personId).map(async (c) => {
              try {
                const res = await fetch(`/api/pandora?personId=${c.personId}`);
                const w = await res.json();
                c.waiverValid = w.valid;
                c.waiverExpiry = w.waiverExpiry;
                return w.valid;
              } catch {
                c.waiverValid = false;
                return false;
              }
            })
          );
          setWaiverStatus(waiverChecks.length > 0 && waiverChecks.every(Boolean) ? "all-valid" : "not-valid");
        } else {
          setWaiverStatus("not-returning");
        }

        setConfirmations(allConfirmations);

        // Generate QR codes per racer
        const qrs: Record<string, string> = {};
        for (const c of allConfirmations) {
          try {
            qrs[c.billId] = await QRCode.toDataURL(c.resCode, { width: 160, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
          } catch { /* skip */ }
        }
        setRacerQrCodes(qrs);
        if (allConfirmations.length > 0) {
          trackBookingComplete(allConfirmations.map(c => c.resNumber).join(","));
        }

        // Add memo to each bill listing related reservations in the group
        if (allConfirmations.length > 1) {
          const memoQs = new URLSearchParams({ endpoint: "booking/memo" });
          for (const conf of allConfirmations) {
            try {
              const others = allConfirmations
                .filter(c => c.billId !== conf.billId && c.resNumber)
                .map(c => `${c.resNumber} (${c.racerName})`)
                .join(", ");
              if (!others) continue;
              const memo = `Group booking — related reservations: ${others}`;
              await fetch(`/api/bmi?${memoQs.toString()}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: `{"orderId":${conf.billId},"memo":"${memo.replace(/"/g, '\\"')}"}`,
              });
            } catch { /* non-fatal */ }
          }
        }

        // If no overview data, build from stored details
        if (!overview?.lines?.length && details) {
          setOrder({
            orderId: Number(id),
            date: details.heat || undefined,
            subTotal: [{ amount: parseFloat(details.amount || "0"), depositKind: 0 }],
            total: [{ amount: parseFloat(details.amount || "0"), depositKind: 0 }],
            totalTax: [{ amount: 0, depositKind: 0 }],
            totalPaid: 0,
            lines: details.race ? [{
              name: details.race,
              quantity: parseFloat(details.qty || "1"),
              totalPrice: [{ amount: parseFloat(details.amount || "0"), depositKind: 0 }],
              productGroup: "Karting",
              scheduledTime: details.heat ? { start: details.heat, stop: "" } : undefined,
            }] : [],
          });
        }

        // Clean up
        localStorage.removeItem(`booking_${id}`);

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
    <div className="min-h-screen bg-[#000418]">
      {/* Hero banner */}
      <div className="relative overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg"
          alt="FastTrax Racing"
          fill
          className="object-cover object-center"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#000418]/60 via-[#000418]/80 to-[#000418]" />
        <div className="relative z-10 pt-36 pb-16 px-4 text-center">
          {loading ? (
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
              <p className="text-white/50 text-sm">Confirming your booking...</p>
            </div>
          ) : error ? (
            <div className="space-y-4">
              <p className="text-red-400 text-lg">{error}</p>
              <a href="/book/race" className="text-[#00E2E5] underline">Book a race</a>
            </div>
          ) : (
            <>
              <div className="w-20 h-20 rounded-full bg-[#00E2E5]/20 border-2 border-[#00E2E5]/50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-[#00E2E5]" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-4xl md:text-5xl font-display uppercase tracking-widest text-white mb-2">
                You&apos;re on the grid!
              </h1>
              <p className="text-white/50 text-sm max-w-md mx-auto">
                {waiverStatus === "all-valid"
                  ? "Your reservation is confirmed. Head straight to the 1st Floor Karting Counter!"
                  : "Your reservation is confirmed. Show your QR code at Guest Services when you arrive."}
              </p>
              {reservationNumber && confirmations.length <= 1 && (
                <p className="text-[#00E2E5] font-display text-2xl uppercase tracking-wider mt-3">{reservationNumber}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Main content */}
      {!loading && orderId && (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-16 pt-6">

          {/* FastTrax Express or waiver warning — front and center */}
          {waiverStatus === "all-valid" ? (
            <div className="rounded-2xl border-2 border-green-500/50 bg-gradient-to-br from-green-500/15 via-green-500/5 to-transparent p-5 sm:p-8 mb-8 shadow-[0_0_30px_rgba(34,197,94,0.15)]">
              <div className="flex items-start gap-4 mb-4">
                <div className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center shrink-0">
                  <svg className="w-7 h-7 text-green-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                </div>
                <div>
                  <p className="text-green-400 text-[10px] font-bold uppercase tracking-widest">New — FastTrax Express</p>
                  <h2 className="text-white font-display text-2xl sm:text-3xl uppercase tracking-wider mt-1">
                    You&apos;re Living Life in the FastTrax!
                  </h2>
                </div>
              </div>
              <p className="text-white/80 text-sm sm:text-base leading-relaxed mb-4 max-w-2xl">
                All waivers in your party are current — <strong className="text-green-400">skip the line at Guest Services</strong> and head directly to the <strong className="text-white">1st Floor Karting Counter</strong>. Just show your QR code and you&apos;re in.
              </p>
              <div className="grid sm:grid-cols-3 gap-2">
                <div className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-3">
                  <div className="w-7 h-7 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</div>
                  <div>
                    <p className="text-white font-semibold text-sm">Go to Karting</p>
                    <p className="text-white/40 text-xs">1st Floor — skip Guest Services</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-3">
                  <div className="w-7 h-7 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</div>
                  <div>
                    <p className="text-white font-semibold text-sm">Show QR Code</p>
                    <p className="text-white/40 text-xs">Get your credentials</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-3">
                  <div className="w-7 h-7 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</div>
                  <div>
                    <p className="text-white font-semibold text-sm">Safety &amp; Race</p>
                    <p className="text-white/40 text-xs">Briefing then grid</p>
                  </div>
                </div>
              </div>
            </div>
          ) : waiverStatus === "not-valid" ? (
            /* Waiver warning banner */
            confirmations.some(c => c.waiverValid === false) && (
              <div className="rounded-2xl border-2 border-amber-500/50 bg-amber-500/10 p-5 mb-8">
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                  </div>
                  <div>
                    <p className="text-amber-400 font-bold text-sm">Waiver Action Needed</p>
                    <p className="text-white/60 text-xs mt-1">
                      The following racers need to complete or renew their waiver at Guest Services (2nd Floor) before racing:
                    </p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {confirmations.filter(c => c.waiverValid === false).map(c => (
                    <div key={c.billId} className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2">
                      <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      <span className="text-white text-sm font-semibold">{c.racerName}</span>
                      {c.waiverExpiry && (
                        <span className="text-amber-400/60 text-xs ml-auto">
                          Expired {new Date(c.waiverExpiry).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      )}
                      {!c.waiverExpiry && <span className="text-amber-400/60 text-xs ml-auto">No waiver on file</span>}
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : null}

          {/* Two-column: racer cards (left) + journey/express (right) on desktop */}
          <div className="grid lg:grid-cols-2 gap-8 mb-8">
            {/* LEFT: Racer cards */}
            <div className={`grid gap-4 ${confirmations.length > 1 && waiverStatus === "all-valid" ? "sm:grid-cols-2 lg:grid-cols-1" : ""}`}>
            {confirmations.map((c) => {
              const ht = c.heatTime || start;
              const arriveBy = waiverStatus === "all-valid" && ht ? fiveMinBefore(ht) : ht ? checkinTime(ht) : null;
              return (
                <div
                  key={c.billId}
                  className={`rounded-2xl p-5 space-y-4 ${
                    waiverStatus === "all-valid"
                      ? "border-2 border-green-500/30 bg-green-500/[0.03] shadow-[0_0_15px_rgba(34,197,94,0.08)]"
                      : "border border-white/10 bg-white/[0.03]"
                  }`}
                >
                  {/* Name — big for check-in staff to see */}
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-white font-display text-2xl uppercase tracking-wider">{c.racerName}</h3>
                    {c.waiverValid === true && (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-green-400 border border-green-500/30 rounded-full px-2 py-0.5 bg-green-500/10 shrink-0">Waiver OK</span>
                    )}
                    {c.waiverValid === false && (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400 border border-amber-500/30 rounded-full px-2 py-0.5 bg-amber-500/10 shrink-0">Waiver Needed</span>
                    )}
                  </div>

                  {/* Reservation + race details */}
                  <div className="flex items-center gap-2">
                    <span className="text-[#00E2E5] font-bold text-sm">{c.resNumber}</span>
                    {c.raceName && (
                      <>
                        <span className="text-white/20">&middot;</span>
                        <span className="text-white/60 text-sm">{c.raceName}</span>
                      </>
                    )}
                  </div>

                  {/* QR + Arrival time side by side */}
                  <div className="flex items-center gap-5">
                    {racerQrCodes[c.billId] && (
                      <div className="shrink-0">
                        <div className="rounded-lg bg-white p-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={racerQrCodes[c.billId]} alt={`QR ${c.resNumber}`} width={100} height={100} className="w-[80px] h-[80px] sm:w-[100px] sm:h-[100px]" />
                        </div>
                      </div>
                    )}
                    <div className="min-w-0">
                      {ht && (
                        <p className="text-white/50 text-sm">
                          {formatDate(ht)} &middot; {formatTime(ht)}
                        </p>
                      )}
                      {arriveBy && (
                        <div className="mt-2">
                          <p className={`text-[10px] font-bold uppercase tracking-wider ${waiverStatus === "all-valid" ? "text-green-400" : "text-red-400"}`}>
                            {waiverStatus === "all-valid" ? "Be at Karting" : "Check In By"}
                          </p>
                          <p className="text-white font-display text-2xl uppercase tracking-widest">
                            {arriveBy}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Fallback: single racer without confirmations array */}
            {confirmations.length === 0 && qrDataUrl && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="flex items-center gap-4">
                  <div className="shrink-0">
                    <div className="rounded-lg bg-white p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={qrDataUrl} alt="QR Code" width={100} height={100} />
                    </div>
                  </div>
                  <div>
                    {reservationNumber && <p className="text-[#00E2E5] font-bold">{reservationNumber}</p>}
                    {raceLine && <p className="text-white text-sm font-semibold">{raceLine.name}</p>}
                    {start && (
                      <p className="text-white/50 text-xs mt-0.5">{formatDate(start)} &middot; {formatTime(start)}</p>
                    )}
                    {start && (
                      <div className="mt-2">
                        <p className="text-red-400 text-[10px] font-bold uppercase tracking-wider">Check In By</p>
                        <p className="text-white font-display text-xl uppercase tracking-widest">{checkinTime(start)}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            </div>

            {/* RIGHT: Journey steps or FastTrack panel */}
            <div className="lg:sticky lg:top-40 lg:self-start">
              {waiverStatus === "all-valid" ? (
                <FastTrackPanel start={start} />
              ) : waiverStatus === "not-returning" ? (
                <RacerJourneySteps />
              ) : (
                <RacerJourneySteps />
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 max-w-md mx-auto">
            <a
              href="/racing"
              className="flex-1 text-center px-5 py-3.5 rounded-xl border border-white/15 text-white/60 hover:border-white/30 hover:text-white text-sm font-semibold transition-colors"
            >
              Racing Info
            </a>
            <a
              href="/book/race"
              className="flex-1 text-center px-5 py-3.5 rounded-xl bg-[#00E2E5] text-[#000418] hover:bg-white text-sm font-bold transition-colors shadow-lg shadow-[#00E2E5]/20"
            >
              Book Another Race
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FastTrack Panel — shown when all returning racers have valid waivers ─────

function FastTrackPanel({ start }: { start: string | null }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border-2 border-green-500/40 bg-gradient-to-br from-green-500/10 via-green-500/5 to-[#000418] p-6 space-y-4">
        {/* Lightning badge */}
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center">
            <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <p className="text-green-400 text-[10px] font-bold uppercase tracking-widest">New — FastTrax Express</p>
            <h2 className="text-white font-display text-xl uppercase tracking-wider">
              Life in the FastTrax
            </h2>
          </div>
        </div>

        {/* Main message */}
        <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-4">
          <p className="text-white text-sm leading-relaxed">
            Your waivers are up to date! <strong className="text-green-400">Skip the line at Guest Services</strong> and proceed directly to the <strong className="text-white">1st Floor Karting Counter</strong> for check-in.
          </p>
        </div>

        {/* Arrival time */}
        {start && (
          <div className="text-center py-3">
            <p className="text-green-400/70 text-[10px] font-bold uppercase tracking-wider mb-1">Arrive at Karting by</p>
            <p className="text-white font-display text-4xl uppercase tracking-widest">
              {fiveMinBefore(start)}
            </p>
            <p className="text-white/40 text-xs mt-1">Just 5 minutes before your heat</p>
          </div>
        )}

        {/* Steps */}
        <div className="space-y-2">
          <div className="flex items-start gap-3 rounded-xl bg-white/[0.03] p-3">
            <div className="w-7 h-7 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</div>
            <div>
              <p className="text-white font-semibold text-sm">Go Straight to Karting</p>
              <p className="text-white/50 text-xs">1st Floor Karting Counter — no Guest Services needed</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl bg-white/[0.03] p-3">
            <div className="w-7 h-7 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</div>
            <div>
              <p className="text-white font-semibold text-sm">Show Your QR Code</p>
              <p className="text-white/50 text-xs">Present it at the karting counter to get your credentials</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl bg-white/[0.03] p-3">
            <div className="w-7 h-7 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</div>
            <div>
              <p className="text-white font-semibold text-sm">Safety Briefing &amp; Race</p>
              <p className="text-white/50 text-xs">Enter the safety briefing and get on the grid</p>
            </div>
          </div>
        </div>
      </div>

      {/* Track status still shown */}
      <RacerJourneyTrackStatus />
    </div>
  );
}

function RacerJourneyTrackStatus() {
  const trackData = useTrackStatus();
  if (!trackData) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-white/30 text-[10px] uppercase tracking-wider font-semibold">Live Track Status</p>
      {trackData.tracks.map((t) => (
        <div
          key={t.trackName}
          className="flex items-center justify-between px-3 py-2 rounded-lg"
          style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${t.colors.trackIdentity}50` }}
        >
          <span className="text-sm font-semibold" style={{ color: t.colors.trackIdentity }}>{t.trackName}</span>
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor(t.status)} animate-pulse`} />
            <span className="text-white/70 text-xs">{t.delayFormatted}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Racer's Journey Steps (no CTAs) ─────────────────────────────────────────

const journeySteps = [
  {
    num: "1",
    title: "ARRIVE 30 MINUTES EARLY",
    subtitle: "",
    desc: "Give yourself the \"Pre-Race Window.\" Arriving early gives you time for any unexpected lines at check-in so you're cleared for the pits without losing a second of track time.",
    color: "rgb(228,28,29)",
  },
  {
    num: "2",
    title: "THE PIT GATE",
    subtitle: "Guest Services \u2014 2nd Floor",
    desc: "STOP HERE FIRST. This is where we verify waivers, check heights/ages, and issue your racing credentials. On weekends, additional team members are at our event check-in desk on the 1st floor.",
    color: "rgb(0,74,173)",
  },
  {
    num: "3",
    title: "TRACKSIDE CHECK-IN",
    subtitle: "1st Floor Karting Counter",
    desc: "Your race time is the close of karting check-in for your heat \u2014 not the start. Be at the 1st floor karting counter at least 5 minutes before your scheduled time to rent your POV camera and enter the safety briefing.",
    color: "rgb(134,82,255)",
  },
];

function dotColor(status: string) {
  return status === "ok" ? "bg-green-400" : status === "delayed" ? "bg-yellow-400" : "bg-red-400";
}

function RacerJourneySteps() {
  const trackData = useTrackStatus();

  return (
    <div className="space-y-4">
      {/* Header + Track Status */}
      <div className="text-center mb-2">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          The Racer&apos;s Journey
        </h2>
        <p className="text-white/40 text-sm">Arrive to Drive</p>
      </div>

      {/* Live Track Status */}
      {trackData && (
        <div className="space-y-1.5">
          <p className="text-white/30 text-[10px] uppercase tracking-wider font-semibold">Live Track Status</p>
          {trackData.tracks.map((t) => (
            <div
              key={t.trackName}
              className="flex items-center justify-between px-3 py-2 rounded-lg"
              style={{ backgroundColor: "rgba(1,10,32,0.6)", border: `1px solid ${t.colors.trackIdentity}50` }}
            >
              <span className="text-sm font-semibold" style={{ color: t.colors.trackIdentity }}>{t.trackName}</span>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor(t.status)} animate-pulse`} />
                <span className="text-white/70 text-xs">{t.delayFormatted}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Journey Steps */}
      <div className="space-y-3">
        {journeySteps.map((s) => (
          <div
            key={s.num}
            className="flex gap-3 items-start p-3 rounded-2xl"
            style={{ backgroundColor: "rgba(7,16,39,0.6)", border: `1.5px dashed ${s.color}40` }}
          >
            <div
              className="shrink-0 flex items-center justify-center font-display text-white text-lg rounded-md"
              style={{ backgroundColor: s.color, width: "36px", height: "48px" }}
            >
              {s.num}
            </div>
            <div>
              <h3 className="font-display uppercase text-sm" style={{ color: s.color }}>{s.title}</h3>
              {s.subtitle && <p className="text-white/40 text-[11px]">{s.subtitle}</p>}
              <p className="text-white/70 text-xs leading-relaxed mt-1">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
