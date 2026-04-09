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

function formatDate(iso: string) {
  return parseLocal(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
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
  /** Per-racer confirmation results */
  const [confirmations, setConfirmations] = useState<{ billId: string; racerName: string; resNumber: string; resCode: string }[]>([]);
  const [waiverUrl, setWaiverUrl] = useState<string | null>(null);
  const [isNewRacer, setIsNewRacer] = useState(false);
  const [fullscreenQr, setFullscreenQr] = useState<{ src: string; resNumber: string } | null>(null);
  /** Stored bill overviews from Redis (saved before payment) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [storedOverviews, setStoredOverviews] = useState<any[]>([]);
  /** Per-racer QR codes */
  const [racerQrCodes, setRacerQrCodes] = useState<Record<string, string>>({});
  /** Claimed POV camera redemption codes */
  const [povCodes, setPovCodes] = useState<string[]>([]);
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

        // Load stored overviews if available
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsedOverviews: any[] = [];
        if (details?.overviews) {
          try { parsedOverviews = JSON.parse(details.overviews); setStoredOverviews(parsedOverviews); } catch { /* skip */ }
        }

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
        const allConfirmations: { billId: string; racerName: string; resNumber: string; resCode: string }[] = [];

        try {
          for (let i = 0; i < allBillIds.length; i++) {
            const bid = allBillIds[i];
            const racerName = racerNames[i] || `Racer ${i + 1}`;
            // Determine amount: for single bill use full amount, for multi-bill check if credit
            let billAmount = amount;
            if (allBillIds.length > 1) {
              // Check this bill's overview to see if it's a credit order
              try {
                const ovRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${bid}`);
                const ov = await ovRes.json();
                const cashT = ov.total?.find((t: { depositKind: number }) => t.depositKind === 0);
                billAmount = cashT?.amount ?? 0;
              } catch { billAmount = 0; }
            }

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
            if (resNum) allConfirmations.push({ billId: bid, racerName: racerName || `Racer ${i + 1}`, resNumber: resNum, resCode });
            // Keep first as primary
            if (i === 0) {
              if (resCode) setReservationCode(resCode);
              if (resNum) setReservationNumber(resNum);
            }
          }
        } catch {
          // Non-fatal — may already be confirmed
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let notificationPayload: Record<string, any> | null = null;

        if (allConfirmations.length > 0) {
          trackBookingComplete(allConfirmations.map(c => c.resNumber).join(","));

          // Update booking record with reservation data
          try {
            const primaryRes = allConfirmations[0];
            await fetch("/api/booking-record", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                billId: id,
                reservationNumber: primaryRes.resNumber,
                reservationCode: primaryRes.resCode,
                status: "confirmed",
                confirmedAt: new Date().toISOString(),
                confirmations: allConfirmations.map(c => ({
                  billId: c.billId,
                  racerName: c.racerName,
                  resNumber: c.resNumber,
                  resCode: c.resCode,
                })),
              }),
            });
          } catch { /* non-fatal */ }

          // Build notification payload (deferred send until waiver URL resolved)
          notificationPayload = (() => {
            const primaryRes = allConfirmations[0];
            const scheduleLines: string[] = [];
            if (overview?.lines) {
              for (const line of overview.lines) {
                const sched = line.scheduledTime || (line.schedules?.[0] ? { start: line.schedules[0].start, stop: line.schedules[0].stop } : null);
                if (sched?.start) {
                  const qty = line.quantity > 1 ? ` x${line.quantity}` : "";
                  scheduleLines.push(`${line.name}${qty} · ${formatTime(sched.start)}${sched.stop ? ` - ${formatTime(sched.stop)}` : ""}`);
                }
              }
            }
            const firstHeat = overview?.lines?.find(l => l.scheduledTime?.start)?.scheduledTime?.start
              || overview?.lines?.[0]?.schedules?.[0]?.start || "";
            return {
              email: details?.email || "",
              phone: details?.phone || "",
              firstName: details?.name?.split(" ")[0] || "",
              smsOptIn: details?.smsOptIn === "true",
              reservationNumber: primaryRes.resNumber,
              reservationName: details?.name || primaryRes.racerName,
              reservationDate: firstHeat ? formatDate(firstHeat) : "",
              reservationTime: firstHeat ? formatTime(firstHeat) : "",
              reservationSchedule: scheduleLines.join("<br/>"),
              reservationCode: primaryRes.resCode || "",
              billId: id || "",
              productNames: overview?.lines?.map(l => l.name) || [],
              scheduledItems: overview?.lines
                ?.filter(l => l.scheduledTime?.start)
                .map(l => ({ name: l.name, start: l.scheduledTime!.start }))
                .sort((a, b) => a.start.localeCompare(b.start)) || [],
            };
          })();
        }

        // Link racers to reservation schedule (returning racers only, fire-and-forget)
        const pidsParam = params.get("personIds");
        const hasReturningRacers = pidsParam && pidsParam.split(",").filter(Boolean).length > 0;
        if (allConfirmations.length > 0 && hasReturningRacers) {
          try {
            const primaryRes = allConfirmations[0];
            const recordRes = await fetch(`/api/booking-record?billId=${id}`);
            if (recordRes.ok) {
              const record = await recordRes.json();
              if (record.racers && Array.isArray(record.racers) && record.racers.some((r: { personId: string }) => r.personId)) {
                // Delay to let Pandora sync the reservation from BMI
                await new Promise(r => setTimeout(r, 8000));
                fetch("/api/pandora/schedule", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ resNumber: primaryRes.resNumber, racers: record.racers }),
                }).then(async (schedRes) => {
                  if (schedRes.ok) {
                    // Mark FastLane = true in booking record
                    fetch("/api/booking-record", {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ billId: id, fastLane: true }),
                    }).catch(() => {});
                  }
                }).catch(() => {});
              }
            }
          } catch { /* non-fatal */ }
        }

        // Waiver link for new racers — get projectReference from Office API
        const personIdsParam = params.get("personIds");
        const isReturning = personIdsParam && personIdsParam.split(",").filter(Boolean).length > 0;
        setIsNewRacer(!isReturning);

        let resolvedWaiverUrl = "";
        if (!isReturning && id) {
          try {
            // Get projectId from bill overview
            const ovRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${id}`);
            const ov = await ovRes.json();
            const projectId = ov.id || id;

            // Get projectReference from Office API
            const projRes = await fetch(`/api/bmi-office?action=project&id=${projectId}`);
            const proj = await projRes.json();
            if (proj.projectReference) {
              resolvedWaiverUrl = `https://kiosk.sms-timing.com/headpinzftmyers/subscribe/event?id=${encodeURIComponent(proj.projectReference)}`;
              setWaiverUrl(resolvedWaiverUrl);
            }
          } catch { /* non-fatal */ }
        }

        // Claim POV codes if POV was purchased
        let claimedPovCodes: string[] = [];
        try {
          // Check stored overviews for POV line items (use local var, not state)
          const allOverviewLines = parsedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
          const povLine = allOverviewLines.find((l: unknown) =>
            String((l as { productId: string }).productId) === "43746981"
          ) as OrderLine | undefined;
          if (povLine && povLine.quantity > 0) {
            const claimRes = await fetch(`/api/pov-codes?action=claim&qty=${povLine.quantity}&billId=${id}&email=${encodeURIComponent(details?.email || "")}`);
            if (claimRes.ok) {
              const claimData = await claimRes.json();
              claimedPovCodes = claimData.codes || [];
              setPovCodes(claimedPovCodes);
              console.log("[POV codes] claimed:", claimedPovCodes);
            }
          }
        } catch (err) {
          console.warn("[POV codes] claim failed:", err);
        }

        // Fire email + SMS confirmation (once per bill — prevent duplicates on revisit)
        const notifKey = `notif_sent_${id}`;
        if (notificationPayload && !sessionStorage.getItem(notifKey)) {
          sessionStorage.setItem(notifKey, "1");
          fetch("/api/notifications/booking-confirmation", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...notificationPayload,
              waiverUrl: !isReturning ? resolvedWaiverUrl : "",
              isNewRacer: !isReturning,
              povCodes: claimedPovCodes,
            }),
          }).catch(() => {});
        }

        // Add POV codes to BMI reservation memo
        if (claimedPovCodes.length > 0 && id) {
          try {
            const memoQs = new URLSearchParams({ endpoint: "booking/memo" });
            const memoBody = `{"orderId":${id},"memo":"POV Codes: ${claimedPovCodes.join(", ")} — Emailed and texted to guest"}`;
            await fetch(`/api/bmi?${memoQs.toString()}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: memoBody,
            });
          } catch { /* non-fatal */ }
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
        sessionStorage.removeItem("attractionCart");
        sessionStorage.removeItem("attractionOrderId");
        sessionStorage.removeItem("checkoutReturnPath");

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
                Your reservation is confirmed. Show your QR code at Guest Services when you arrive.
              </p>
              {/* Reservation number shown on the card, not here */}
            </>
          )}
        </div>
      </div>

      {/* Main content */}
      {!loading && orderId && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-16 pt-6">

          {/* Waiver banner — new racers only */}
          {isNewRacer && waiverUrl && (
            <div className="rounded-2xl border-2 border-red-500/60 bg-gradient-to-br from-red-500/15 via-red-500/5 to-transparent p-5 sm:p-6 mb-8 shadow-[0_0_30px_rgba(239,68,68,0.15)]">
              <div className="flex items-start gap-4 mb-4">
                <div className="w-14 h-14 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center shrink-0 animate-pulse">
                  <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <div>
                  <p className="text-red-400 text-xs font-bold uppercase tracking-widest">Action Required</p>
                  <h2 className="text-white font-display text-xl sm:text-2xl uppercase tracking-wider mt-1">
                    Complete Your Waiver
                  </h2>
                </div>
              </div>
              <p className="text-white/80 text-sm leading-relaxed mb-4 max-w-2xl">
                <strong className="text-red-400">Every racer must complete their own waiver before racing.</strong> Each person in your party needs to sign individually. Parents or guardians must register themselves first, then add any minors to their waiver.
              </p>
              <a
                href={waiverUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base bg-red-500 text-white hover:bg-red-400 transition-colors shadow-lg shadow-red-500/30"
              >
                Complete Waiver Now
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <p className="text-white/40 text-xs mt-3">Opens in a new tab. Each adult signs their own waiver. Parents: register yourself first, then add your minors.</p>
            </div>
          )}

          {/* Layout: single reservation = full-width card then two-col journey below.
              Multiple = cards left, journey right */}
          <div className={`${confirmations.length > 1 ? "grid lg:grid-cols-2 gap-8" : ""} mb-8`}>
          <div className="space-y-6">
            {(() => {
              // Build racer cards from confirmations + stored overviews
              const cards = confirmations.length > 0 ? confirmations : [{
                billId: orderId || "", racerName: "", resNumber: reservationNumber || "", resCode: reservationCode || ""
              }];

              return cards.map((c, ci) => {
                const qr = racerQrCodes[c.billId] || qrDataUrl;
                // Find stored overview for this bill to get heat time
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const ov = storedOverviews.find((o: any) => o._billId === c.billId || o.id === c.billId) || (ci === 0 ? order : null);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const lines = (ov?.lines || []) as any[];
                const firstHeat = lines.find((l: { scheduledTime?: { start: string }; schedules?: { start: string }[] }) =>
                  l.scheduledTime?.start || l.schedules?.[0]?.start
                );
                const heatStart = firstHeat?.scheduledTime?.start || firstHeat?.schedules?.[0]?.start || start;

                return (
                  <div key={c.billId || ci} className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
                    {/* Header: racer name + reservation (multi-bill only) */}
                    {confirmations.length > 1 && (
                      <div className="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between bg-white/[0.02]">
                        <div>
                          <p className="text-white font-display text-lg uppercase tracking-wider">{c.racerName}</p>
                        </div>
                        {ci === 0 && confirmations.length > 1 && (
                          <span className="text-xs font-bold uppercase tracking-wider text-[#00E2E5]/50 border border-[#00E2E5]/20 rounded-full px-2 py-0.5">Primary</span>
                        )}
                      </div>
                    )}

                    {/* QR + check-in info */}
                    <div className={`p-4 sm:p-5 flex items-center gap-4 sm:gap-6 ${confirmations.length <= 1 ? "sm:p-8 sm:gap-8" : ""}`}>
                      {qr && (
                        <button className="shrink-0 cursor-pointer" onClick={() => setFullscreenQr({ src: qr, resNumber: c.resNumber || reservationNumber || "" })}>
                          <div className="rounded-lg bg-white p-1.5 sm:p-2 hover:shadow-lg hover:shadow-[#00E2E5]/20 transition-shadow">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={qr} alt={`QR ${c.resNumber}`} width={140} height={140} className={`${confirmations.length <= 1 ? "w-[120px] h-[120px] sm:w-[160px] sm:h-[160px]" : "w-[80px] h-[80px]"}`} />
                          </div>
                          <p className="text-white/20 text-xs text-center mt-1">Tap to enlarge</p>
                        </button>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className={`text-[#00E2E5] font-bold ${confirmations.length <= 1 ? "text-2xl sm:text-3xl" : "text-lg"}`}>{c.resNumber || reservationNumber}</p>
                        {heatStart && <p className={`text-white/50 ${confirmations.length <= 1 ? "text-sm mt-1" : "text-xs"}`}>{formatDate(heatStart)}</p>}
                        {heatStart && (
                          <div className={`${confirmations.length <= 1 ? "mt-3" : "mt-1.5"}`}>
                            <p className="text-red-400 text-xs font-bold uppercase tracking-wider">Check In By</p>
                            <p className={`text-white font-display uppercase tracking-widest ${confirmations.length <= 1 ? "text-3xl sm:text-4xl" : "text-xl"}`}>{checkinTime(heatStart)}</p>
                            <p className="text-white/30 text-xs">Guest Services, 2nd Floor</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Race list — names and times */}
                    {lines.length > 0 && (
                      <div className="border-t border-white/[0.06] px-4 py-3 space-y-1.5">
                        {lines.map((line: { name: string; quantity: number; scheduledTime?: { start: string }; schedules?: { start: string }[] }, li: number) => {
                          const lineTime = line.scheduledTime?.start || line.schedules?.[0]?.start;
                          return (
                            <div key={li} className="flex items-center justify-between">
                              <p className="text-white text-sm">{line.name}{line.quantity > 1 ? ` x${line.quantity}` : ""}</p>
                              {lineTime && <p className="text-white/40 text-xs">{formatTime(lineTime)}</p>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Fallback if no stored lines */}
                    {lines.length === 0 && raceLine && ci === 0 && (
                      <div className="border-t border-white/[0.06] px-4 py-3">
                        <p className="text-white text-sm">{raceLine.name}{raceLine.quantity > 1 ? ` x${raceLine.quantity}` : ""}</p>
                      </div>
                    )}
                  </div>
                );
              });
            })()}

          </div>

          {/* POV Camera Codes */}
          {povCodes.length > 0 && (
            <div className="lg:col-span-2 mt-6 rounded-2xl border border-purple-500/20 bg-purple-500/5 p-6 sm:p-8">
              <h3 className="font-display text-white text-xl uppercase tracking-widest mb-4">Your ViewPoint POV Camera Codes</h3>
              <p className="text-white/50 text-sm leading-relaxed mb-6">
                After your race, be sure to collect your POV camera slip. Without this slip, you will not be able to get your video. Scan the QR code on the slip and enter the codes below to redeem your video. Videos take 15-30 minutes to upload.
              </p>
              <div className="flex flex-wrap gap-4">
                {povCodes.map((code, i) => (
                  <div key={i} className="bg-white/10 border border-purple-500/30 rounded-lg px-5 py-3">
                    <p className="text-purple-300 text-xs font-semibold uppercase tracking-wider mb-1">Code {i + 1}</p>
                    <p className="text-white font-mono text-xl font-bold tracking-wider">{code}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RIGHT: Racer's Journey (only in grid for multi-bill) */}
          {confirmations.length > 1 && (
            <div className="lg:sticky lg:top-40 lg:self-start">
              <RacerJourneySteps />
            </div>
          )}
          </div>

          {/* Journey below for single reservation */}
          {confirmations.length <= 1 && (
            <div className="max-w-2xl mx-auto mb-8">
              <RacerJourneySteps />
            </div>
          )}
        </div>
      )}

      {/* Fullscreen QR modal */}
      {fullscreenQr && (
        <div
          className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center"
          onClick={() => setFullscreenQr(null)}
        >
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fullscreenQr.src} alt="QR Code" className="w-[280px] h-[280px] sm:w-[350px] sm:h-[350px] mx-auto" />
            <p className="text-black font-bold text-3xl mt-6">{fullscreenQr.resNumber}</p>
            <p className="text-gray-500 text-sm mt-2">Tap anywhere to close</p>
          </div>
        </div>
      )}
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
          <p className="text-white/30 text-xs uppercase tracking-wider font-semibold">Live Track Status</p>
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
              {s.subtitle && <p className="text-white/40 text-[13px]">{s.subtitle}</p>}
              <p className="text-white/70 text-xs leading-relaxed mt-1">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
