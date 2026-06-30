"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import { checkinQrDataUrl } from "@/lib/qr-checkin";
import { getBookingClientKey, clearBookingLocation } from "@/lib/booking-location";
import { bmiGet, getRaceProductById } from "../../race/data";
import { trackBookingComplete } from "@/lib/analytics";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { modalBackdropProps } from "@/lib/a11y";
import { productDisplayNameFromPackages, getPackageIgnoreFlag } from "@/lib/packages";
import { buildReservationMemo } from "~/features/booking/service/reservation-memo";
import { ATTRACTIONS, type AttractionConfig } from "@/lib/attractions-data";
import { comboAddonEnabled, comboReservationNote, getComboSpecial } from "~/features/combos";
import AddGuestsCard from "~/components/features/booking/confirmation/AddGuestsCard";
import { BowlingPlayersEditor } from "~/components/features/booking/confirmation/BowlingPlayersEditor";

/** Resolve a race line's display name from our own registries instead
 *  of trusting BMI's public-facing name. BMI's bill/overview API has
 *  shipped wrong public names on package-only SKUs (productId 45811415
 *  came back as "Intermediate Race Mega" for what's actually a Blue
 *  Track booking). Cascade:
 *
 *    1. PACKAGES (lib/packages.ts) — catches every package-only SKU
 *       (Ultimate Qualifier, Rookie Pack, etc.) with track-aware names.
 *    2. RACE_PRODUCTS (app/book/race/data.ts) — catches every standalone
 *       race SKU. Belt-and-suspenders for any future BMI catalog drift.
 *    3. BMI's own line.name — fallback for productGroups we don't model
 *       (License fees, POV, attractions add-ons, etc.).
 */
function displayLineName(line: { productId?: string | number; name: string }): string {
  return (
    productDisplayNameFromPackages(line.productId) ??
    getRaceProductById(line.productId)?.name ??
    line.name
  );
}

// Booking type detection — determines which features are active
type BookingType = "racing" | "attraction";

const BOOKING_API_KEY = "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

function detectBookingType(
  details: Record<string, string> | null,
  lines: { productGroup: string }[],
): BookingType {
  if (details?.attraction) return "attraction";
  if (lines.some((l) => l.productGroup === "Karting")) return "racing";
  return "attraction"; // default
}

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
  return parseLocal(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function checkinTime(iso: string) {
  const d = parseLocal(iso);
  d.setMinutes(d.getMinutes() - 30);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string) {
  return parseLocal(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Resolve the Pandora `sessionId` for each racer by fetching today's sessions
 * per track and matching on (track + heatStart minute). Returns racers with
 * `sessionId` attached when a match is found; leaves others untouched.
 *
 * Used to power the `bookingrecord:express:session:{sessionId}` reverse index
 * so the checkin-alerts cron can reach express-lane holders who bypass
 * Pandora's Guest Services check-in.
 */
async function attachSessionIds<
  T extends { track?: string | null; heatStart?: string; sessionId?: string | number | null },
>(racers: T[]): Promise<T[]> {
  if (!Array.isArray(racers) || racers.length === 0) return racers;

  const tracks = new Set(racers.map((r) => r.track).filter((t): t is string => !!t));
  if (tracks.size === 0) return racers;

  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startDate = `${ymd}T00:00:00`;
  const endDate = `${ymd}T23:59:59`;
  const locationId = "LAB52GY480CJF";

  // Normalize to ET wall-clock minute. Booking records may store heatStart as
  // naked local ET (no tz) while Pandora sessions-list returns UTC Z — converting
  // both to ET wall-clock lets them compare.
  const minuteKey = (iso: string): string => {
    if (!/Z$|[+-]\d{2}:\d{2}$/.test(iso)) return iso.slice(0, 16);
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 16);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  };
  const resourceFor = (track: string): string | null => {
    const t = track.toLowerCase();
    if (t === "blue") return "Blue Track";
    if (t === "red") return "Red Track";
    // Pandora's /bmi/sessions expects "Mega Track" — the shorter "Mega"
    // silently 404s, which is why attachSessionIds never populated
    // sessionId on Tuesday bookings.
    if (t === "mega") return "Mega Track";
    return null;
  };

  const lookup = new Map<string, string>(); // `${track}|${minute}` → sessionId
  await Promise.all(
    Array.from(tracks).map(async (track) => {
      const resourceName = resourceFor(track);
      if (!resourceName) return;
      try {
        const qs = new URLSearchParams({ locationId, resourceName, startDate, endDate });
        const res = await fetch(`/api/pandora/sessions?${qs.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        const sessions: { sessionId: string; scheduledStart: string }[] = Array.isArray(data?.data)
          ? data.data
          : [];
        for (const s of sessions) {
          if (!s?.scheduledStart || !s?.sessionId) continue;
          lookup.set(`${track}|${minuteKey(s.scheduledStart)}`, s.sessionId);
        }
      } catch {
        /* graceful: leave racers without sessionId */
      }
    }),
  );

  return racers.map((r) => {
    if (r.sessionId) return r;
    if (!r.track || !r.heatStart) return r;
    const sid = lookup.get(`${r.track}|${minuteKey(r.heatStart)}`);
    return sid ? { ...r, sessionId: sid } : r;
  });
}

interface Schedule {
  start: string;
  stop?: string;
  name?: string;
}

interface OrderLine {
  name: string;
  /** BMI productId — used by `displayLineName` to override BMI's
   *  public-facing line name with our own registry value. Optional
   *  because some legacy stored overviews predate this field. */
  productId?: string | number;
  quantity: number;
  /** Number of racers on this line. For an Ultimate Qualifier with
   *  4 racers, both the Starter and Intermediate lines have
   *  persons=4. Drives the sales-log participantCount math via the
   *  scheduledItems payload — see route.ts. */
  persons?: number;
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

/** Itemized day-of Square order for the "What you paid for" card. Sourced from
 *  GET /api/booking/v2/receipt (the authoritative Square day-of order). */
interface ReceiptData {
  lineItems: { name: string; quantity: number; amountCents: number }[];
  discounts: { name: string; amountCents: number }[];
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidOnlineCents: number;
  dueAtCenterCents: number;
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
  const [confirmations, setConfirmations] = useState<
    { billId: string; racerName: string; resNumber: string; resCode: string }[]
  >([]);
  const [waiverUrl, setWaiverUrl] = useState<string | null>(null);
  const [isNewRacer, setIsNewRacer] = useState(false);
  const [fullscreenQr, setFullscreenQr] = useState<{ src: string; resNumber: string } | null>(null);
  /** Stored bill overviews from Redis (saved before payment) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [storedOverviews, setStoredOverviews] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bookingRec, setBookingRec] = useState<Record<string, any> | null>(null);
  /** Per-racer QR codes */
  const [racerQrCodes, setRacerQrCodes] = useState<Record<string, string>>({});
  /** Claimed POV camera redemption codes */
  const [povCodes, setPovCodes] = useState<string[]>([]);
  /** Check-in location based on first scheduled item */
  const [checkInLocation, setCheckInLocation] = useState<"fasttrax" | "headpinz">("fasttrax");
  const [bookingType, setBookingType] = useState<BookingType>("racing");
  /** Itemized day-of Square receipt ("what you paid for"); null until loaded. */
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  /** Express lane — returning racers with all valid waivers skip Guest Services */
  const [expressLane, setExpressLane] = useState(false);
  /** Race groups — confirmations grouped by heat for display */
  const [raceGroups, setRaceGroups] = useState<
    {
      product: string;
      track: string | null;
      heatStart: string;
      heatName: string;
      racers: string[];
      racerDetails: { name: string; personId?: string; sessionId?: string | number | null }[];
      resNumber: string;
      resCode: string;
      billId: string;
    }[]
  >([]);
  const [checkinQrByPerson, setCheckinQrByPerson] = useState<Record<string, string>>({});
  /** Appetizer info derived from the booking's package. Carries the
   *  per-package note ("1 per group" vs "1 per 3 purchases") and
   *  valid menu items so the confirmation card renders the right
   *  copy for Rookie Pack vs Ultimate Qualifier. `null` = no
   *  appetizer promo for this booking. */
  const [appetizerInfo, setAppetizerInfo] = useState<{
    note: string;
    items: string[];
    packageLabel: string;
  } | null>(null);
  const [confirmFailed, setConfirmFailed] = useState(false);
  /** Multi-activity hub: which activity the guest tapped into. `null`
   *  = the hub (button list). Only meaningful when the booking has 2+
   *  activities; single-activity bookings ignore this and render as v1. */
  const [selectedActivity, setSelectedActivity] = useState<{
    kind: "racing" | "attraction" | "bowling";
    index: number;
  } | null>(null);
  const confirmStarted = useRef(false);
  const liveStatus = useTrackStatus();
  const currentRaces = liveStatus?.currentRaces ?? null;

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
        } catch {
          /* Redis unavailable */
        }
        if (!details) {
          const stored = localStorage.getItem(`booking_${id}`);
          if (stored) details = JSON.parse(stored);
        }

        const amount = details?.amount ? parseFloat(details.amount) : 0;

        // Load stored overviews if available
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsedOverviews: any[] = [];
        if (details?.overviews) {
          try {
            parsedOverviews = JSON.parse(details.overviews);
            setStoredOverviews(parsedOverviews);
          } catch {
            /* skip */
          }
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

        // Detect booking type
        const detectedType = detectBookingType(details, overview?.lines || []);
        setBookingType(detectedType);

        // Determine check-in location from first scheduled item
        const allLines =
          overview?.lines ||
          parsedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
        const scheduledLines = allLines
          .filter((l: OrderLine) => l.scheduledTime?.start)
          .sort((a: OrderLine, b: OrderLine) =>
            (a.scheduledTime?.start || "").localeCompare(b.scheduledTime?.start || ""),
          );
        if (scheduledLines.length > 0) {
          const firstName = scheduledLines[0].name.toLowerCase();
          if (
            firstName.includes("gel") ||
            firstName.includes("laser") ||
            (firstName.includes("shuffly") && firstName.includes("hpfm"))
          ) {
            setCheckInLocation("headpinz");
          }
        }

        // Confirm payment on ALL bills (multi-bill for per-person credits)
        const billIdsParam = params.get("billIds");
        const racerNamesParam = params.get("racerNames");
        const allBillIds = billIdsParam ? billIdsParam.split(",") : [id!];
        const racerNames = racerNamesParam
          ? racerNamesParam.split(",").map(decodeURIComponent)
          : [];
        const allConfirmations: {
          billId: string;
          racerName: string;
          resNumber: string;
          resCode: string;
        }[] = [];

        for (let i = 0; i < allBillIds.length; i++) {
          const bid = allBillIds[i];
          const racerName = racerNames[i] || "";
          let billAmount = amount;
          if (allBillIds.length > 1) {
            try {
              const ovRes = await fetch(
                `/api/sms?endpoint=bill%2Foverview&billId=${bid}${getBookingClientKey() ? `&clientKey=${getBookingClientKey()}` : ""}`,
              );
              const ov = await ovRes.json();
              const cashT = ov.total?.find((t: { depositKind: number }) => t.depositKind === 0);
              billAmount = cashT?.amount ?? 0;
            } catch {
              billAmount = 0;
            }
          }

          // Server-side idempotent confirm — safe against page reloads,
          // double-fires, and React re-renders. Never calls BMI twice
          // for the same billId.
          try {
            const confirmRes = await fetch("/api/booking/confirm", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                billId: bid,
                amount: billAmount,
                clientKey: getBookingClientKey() || undefined,
              }),
            });
            if (confirmRes.ok) {
              const result = await confirmRes.json();
              const resNum = result.reservationNumber || "";
              const resCode = String(result.reservationCode || `r${bid}`);
              if (resNum) {
                allConfirmations.push({ billId: bid, racerName, resNumber: resNum, resCode });
              }
              if (result.alreadyConfirmed) {
                console.log(`[confirm] ${bid} already confirmed → ${resNum}`);
              }
            } else {
              const errText = await confirmRes.text();
              console.error(`[confirm] ${bid} failed: ${confirmRes.status} ${errText}`);
            }
          } catch (err) {
            console.error(`[confirm] ${bid} threw:`, err);
          }

          if (i === 0) {
            const first = allConfirmations[0];
            if (first?.resCode) setReservationCode(first.resCode);
            if (first?.resNumber) setReservationNumber(first.resNumber);
          }
        }
        setConfirmations(allConfirmations);

        // Generate QR codes per racer
        const qrs: Record<string, string> = {};
        for (const c of allConfirmations) {
          try {
            qrs[c.billId] = await QRCode.toDataURL(c.resCode, {
              width: 160,
              margin: 1,
              color: { dark: "#000000", light: "#ffffff" },
            });
          } catch {
            /* skip */
          }
        }
        setRacerQrCodes(qrs);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let notificationPayload: Record<string, any> | null = null;

        if (allConfirmations.length === 0 && allBillIds.length > 0) {
          console.error(
            `[confirmation] all payment/confirm attempts failed for bills: ${allBillIds.join(",")}`,
          );
          setConfirmFailed(true);
        }

        if (allConfirmations.length > 0) {
          trackBookingComplete(allConfirmations.map((c) => c.resNumber).join(","));
          clearBookingLocation();

          // Update booking record with reservation data
          try {
            const primaryRes = allConfirmations[0];
            const patchRes = await fetch("/api/booking-record", {
              method: "PATCH",
              headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
              body: JSON.stringify({
                billId: id,
                reservationNumber: primaryRes.resNumber,
                reservationCode: primaryRes.resCode,
                status: "confirmed",
                confirmedAt: new Date().toISOString(),
                confirmations: allConfirmations.map((c) => ({
                  billId: c.billId,
                  racerName: c.racerName,
                  resNumber: c.resNumber,
                  resCode: c.resCode,
                })),
              }),
            });
            if (!patchRes.ok) console.error("[booking-record] PATCH failed:", patchRes.status);
          } catch (err) {
            console.error("[booking-record] PATCH threw:", err);
          }

          // Build notification payload (deferred send until waiver URL resolved)
          notificationPayload = (() => {
            const primaryRes = allConfirmations[0];
            // Prefer BMI's live overview, but fall back to whatever
            // the booking flow stored in `details.overviews` (racing
            // OrderSummary + attractions [attraction]/page both
            // persist this now). Without the fallback, attraction
            // bookings whose order is converted before the email
            // fires lose all their date/time/schedule fields — the
            // user reported a HeadPinz Naples gel-blaster booking
            // arriving with empty Date / Time / Schedule rows.
            const sourceLines: OrderLine[] =
              overview?.lines && overview.lines.length > 0
                ? overview.lines
                : parsedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
            const scheduleLines: string[] = [];
            for (const line of sourceLines) {
              const sched =
                line.scheduledTime ||
                (line.schedules?.[0]
                  ? { start: line.schedules[0].start, stop: line.schedules[0].stop }
                  : null);
              if (sched?.start) {
                const qty = line.quantity > 1 ? ` x${line.quantity}` : "";
                scheduleLines.push(
                  `${displayLineName(line)}${qty} · ${formatTime(sched.start)}${sched.stop ? ` - ${formatTime(sched.stop)}` : ""}`,
                );
              }
            }
            const firstHeat =
              sourceLines.find((l) => l.scheduledTime?.start)?.scheduledTime?.start ||
              sourceLines[0]?.schedules?.[0]?.start ||
              "";
            return {
              // Route the receipt link to the v2 confirmation page (this page),
              // not the v1 /book/confirmation that can't render a v2 booking.
              confirmationV2: true,
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
              productNames: sourceLines.map((l) => displayLineName(l)),
              // Include `persons` (or `quantity` fallback) so the
              // sales-log participantCount math can take the MAX
              // across karting lines instead of counting lines —
              // counting lines double-counted Ultimate Qualifier
              // bookings (Starter + Intermediate = 2 lines per
              // racer). See app/api/notifications/booking-
              // confirmation/route.ts for the math.
              scheduledItems: sourceLines
                .filter((l) => l.scheduledTime?.start)
                .map((l) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const persons = (l as any).persons as number | undefined;
                  return {
                    name: displayLineName(l),
                    start: l.scheduledTime!.start,
                    persons: typeof persons === "number" ? persons : undefined,
                    quantity: l.quantity,
                  };
                })
                .sort((a, b) => a.start.localeCompare(b.start)),
            };
          })();
        }

        // Get racer data from booking record (primary source of truth)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let bookingRecord: Record<string, any> | null = null;
        try {
          const recRes = await fetch(`/api/booking-record?billId=${id}`, {
            headers: { "x-api-key": BOOKING_API_KEY },
          });
          if (recRes.ok) {
            bookingRecord = await recRes.json();
            setBookingRec(bookingRecord);
          }
        } catch {
          /* non-fatal */
        }

        // Resolve the booking's package (centralized registry — see
        // lib/packages.ts) so we know whether to render the
        // appetizer-code card. Two paths:
        //  1. `bookingRecord.package` (new) — package id, look up
        //     the definition + read its `appetizerCode`.
        //  2. `bookingRecord.rookiePack: true` (legacy field on
        //     pre-deploy bookings) — fall back to the rookie-pack
        //     definition for the appetizer.
        try {
          const { getPackageIgnoreFlag } = await import("@/lib/packages");
          const pkgId = bookingRecord?.package as string | null | undefined;
          const pkg = pkgId
            ? getPackageIgnoreFlag(pkgId)
            : bookingRecord?.rookiePack === true
              ? getPackageIgnoreFlag("rookie-pack")
              : null;
          if (pkg?.appetizerCode) {
            setAppetizerInfo({
              note: pkg.appetizerNote ?? "1 per group",
              items: pkg.appetizerItems ?? [
                "Bruschetta",
                "GF Mac & Cheese Bites",
                "Fried Zucchini Sticks",
              ],
              packageLabel: pkg.name,
            });
          }
        } catch {
          if (bookingRecord?.rookiePack === true) {
            setAppetizerInfo({
              note: "1 per group",
              items: ["Bruschetta", "GF Mac & Cheese Bites", "Fried Zucchini Sticks"],
              packageLabel: "Rookie Pack",
            });
          }
        }

        // Build race groups — group racers by heat for display tiles
        if (
          bookingRecord?.racers &&
          Array.isArray(bookingRecord.racers) &&
          bookingRecord.racers.length > 0
        ) {
          const recRacers = bookingRecord.racers as {
            racerName?: string;
            personId?: string;
            product?: string;
            track?: string | null;
            heatStart?: string;
            heatName?: string;
          }[];
          const primary = allConfirmations[0] || {
            billId: id!,
            resNumber: reservationNumber || "",
            resCode: reservationCode || "",
          };

          // Group racers by heat (product + heatStart)
          const groupMap = new Map<
            string,
            {
              product: string;
              track: string | null;
              heatStart: string;
              heatName: string;
              racers: string[];
              racerDetails: {
                name: string;
                personId?: string;
                sessionId?: string | number | null;
              }[];
            }
          >();
          for (const r of recRacers) {
            const key = `${r.product || "Race"}|${r.heatStart || ""}`;
            if (!groupMap.has(key)) {
              groupMap.set(key, {
                product: r.product || "Race",
                track: r.track || null,
                heatStart: r.heatStart || "",
                heatName: r.heatName || "",
                racers: [],
                racerDetails: [],
              });
            }
            const g = groupMap.get(key)!;
            g.racers.push(r.racerName || "Racer");
            g.racerDetails.push({
              name: r.racerName || "Racer",
              personId: r.personId,
            });
          }

          const groups = [...groupMap.values()].map((g) => ({
            ...g,
            resNumber: primary.resNumber,
            resCode: primary.resCode,
            billId: primary.billId,
          }));

          // Fallback: check bill overview for scheduled races not in racer assignments
          // (handles "Add Another Race" where racerNames may not have been set)
          const coveredHeats = new Set(groups.map((g) => g.heatStart));
          for (const ov of bookingRecord.overviews || []) {
            for (const line of ov.lines || []) {
              if (line.productGroup !== "Karting" || !line.scheduledTime?.start) continue;
              if (coveredHeats.has(line.scheduledTime.start)) continue;
              // This scheduled race has no racer assignments — add it as a group
              const trackMatch = (line.name || "").match(/(Red|Blue|Mega)/i);
              groups.push({
                product: line.name,
                track: trackMatch ? trackMatch[1] : null,
                heatStart: line.scheduledTime.start,
                heatName: line.name,
                racers: Array.from({ length: line.quantity || 1 }, (_, i) => `Racer ${i + 1}`),
                racerDetails: Array.from({ length: line.quantity || 1 }, (_, i) => ({
                  name: `Racer ${i + 1}`,
                })),
                resNumber: primary.resNumber,
                resCode: primary.resCode,
                billId: primary.billId,
              });
            }
          }
          // Sort by heat start time
          groups.sort((a, b) => a.heatStart.localeCompare(b.heatStart));

          setRaceGroups(groups);

          // Backfill racer name from the booking-record racers list
          // when the URL didn't pass `racerNames`. Only override if a
          // real name exists — never fall back to synthetic "Racer".
          if (allConfirmations.length === 1 && !allConfirmations[0].racerName) {
            const realName = recRacers[0]?.racerName || bookingRecord.contact?.firstName;
            if (realName) allConfirmations[0].racerName = realName;
          }
          setConfirmations([...allConfirmations]);
        }

        // Get personIds — from booking record first, URL params as fallback
        const recPersonIds = (bookingRecord?.racers || [])
          .map((r: { personId?: string }) => r.personId)
          .filter(Boolean);
        const urlPersonIds = (params.get("personIds") || "").split(",").filter(Boolean);
        const personIds = recPersonIds.length > 0 ? recPersonIds : urlPersonIds;
        const hasReturningRacers = personIds.length > 0;

        // Express Lane: returning racers with valid waivers skip Guest Services.
        // Gate on actual racer data, not the brittle detectBookingType heuristic
        // (which can't see racing on a converted/seeded order with no live overview).
        const allRacers = (bookingRecord?.racers ?? []) as Array<{ personId?: string | null }>;
        const hasRacers = allRacers.length > 0;
        // EVERY racer must be a resolved returning racer. A racer with no
        // personId (a new/unregistered second racer typed in by name) has no
        // waiver on file and must be sent to Guest Services — that drops express
        // for the whole party, even if the one resolved racer's waiver is valid.
        const allRacersResolved = hasRacers && allRacers.every((r) => !!r.personId);
        let allWaiversValid = false;
        if (hasRacers && hasReturningRacers && allRacersResolved) {
          if (bookingRecord?.fastLane === true) {
            allWaiversValid = true;
            setExpressLane(true);
          } else {
            // Check waivers via Pandora
            try {
              const waiverChecks = await Promise.all(
                personIds.map((pid: string) =>
                  fetch(`/api/pandora?personId=${pid}`)
                    .then((r) => r.json())
                    .catch(() => ({ valid: false })),
                ),
              );
              allWaiversValid =
                waiverChecks.length > 0 && waiverChecks.every((w: { valid: boolean }) => w.valid);
              setExpressLane(allWaiversValid);
            } catch {
              /* non-fatal */
            }
          }
        }

        // Per-racer check-in QR — generate immediately for any racers that
        // already carry a Pandora sessionId (persisted from a prior sync, or a
        // returning racer revisiting this page). The live schedule-link block
        // below refreshes/adds these once BMI→Pandora finishes syncing. QR is
        // pure client-side (FT:personId:sessionId), so no network is required.
        try {
          type R = { personId?: string; sessionId?: string | number | null };
          const ready = ((bookingRecord?.racers as R[] | undefined) ?? []).filter(
            (r): r is R & { personId: string; sessionId: string | number } =>
              !!r.personId &&
              r.sessionId != null &&
              /^\d+$/.test(String(r.personId)) &&
              /^\d+$/.test(String(r.sessionId)),
          );
          if (ready.length > 0) {
            const entries = await Promise.all(
              ready.map(async (r) => {
                try {
                  return {
                    pid: r.personId,
                    url: await checkinQrDataUrl(r.personId, String(r.sessionId), 320),
                  };
                } catch {
                  return null;
                }
              }),
            );
            const map: Record<string, string> = {};
            for (const e of entries) if (e) map[e.pid] = e.url;
            if (Object.keys(map).length > 0) setCheckinQrByPerson(map);
          }
        } catch {
          /* non-fatal */
        }

        // Link racers to reservation schedule (racing returning racers only, fire-and-forget)
        if (detectedType === "racing" && allConfirmations.length > 0 && hasReturningRacers) {
          try {
            const primaryRes = allConfirmations[0];
            if (
              bookingRecord?.racers &&
              Array.isArray(bookingRecord.racers) &&
              bookingRecord.racers.some((r: { personId: string }) => r.personId)
            ) {
              // Delay to let Pandora sync the reservation from BMI
              await new Promise((r) => setTimeout(r, 8000));
              fetch("/api/pandora/schedule", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  resNumber: primaryRes.resNumber,
                  racers: bookingRecord.racers,
                }),
              })
                .then(async (schedRes) => {
                  if (schedRes.ok) {
                    // Resolve Pandora sessionId per racer so the checkin cron can
                    // reach express-lane holders via bookingrecord:express:session:*
                    const racersWithSession = await attachSessionIds(bookingRecord.racers);
                    // Mark FastLane based on waiver check result
                    fetch("/api/booking-record", {
                      method: "PATCH",
                      headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
                      body: JSON.stringify({
                        billId: id,
                        fastLane: allWaiversValid,
                        racers: racersWithSession,
                      }),
                    }).catch(() => {});
                    // Generate check-in QR codes for racers with sessionIds
                    type RacerWithIds = { personId?: string; sessionId?: string | number | null };
                    const qrTargets = (racersWithSession as RacerWithIds[]).filter(
                      (r): r is RacerWithIds & { personId: string; sessionId: string | number } =>
                        !!r.personId &&
                        !!r.sessionId &&
                        /^\d+$/.test(String(r.personId)) &&
                        /^\d+$/.test(String(r.sessionId)),
                    );
                    const qrEntries = await Promise.all(
                      qrTargets.map(async (r) => {
                        try {
                          const url = await checkinQrDataUrl(r.personId, String(r.sessionId), 320);
                          return { pid: r.personId, url };
                        } catch {
                          return null;
                        }
                      }),
                    );
                    const qrMap: Record<string, string> = {};
                    for (const e of qrEntries) if (e) qrMap[e.pid] = e.url;
                    setCheckinQrByPerson(qrMap);
                  }
                })
                .catch(() => {});
            }
          } catch {
            /* non-fatal */
          }
        }

        // (Express Lane / POV / group / package notes are no longer written as
        // separate memos here — they're composed into ONE combined memo below so
        // none overrides another. See the "combined reservation memo" block.)

        // Waiver link for new racers — get projectReference from Office API
        const isReturning = hasReturningRacers;
        setIsNewRacer(!isReturning);

        // Waiver link — only for activities that require waivers (racing, gel blaster, laser tag)
        // Duck pin and shuffly don't need waivers
        const waiverLines =
          overview?.lines ||
          parsedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
        const lineNames = waiverLines.map((l: OrderLine) => l.name.toLowerCase());
        const needsWaiver = lineNames.some(
          (n: string) =>
            n.includes("race") || n.includes("gel") || n.includes("laser") || n.includes("blaster"),
        );

        let resolvedWaiverUrl = "";
        if (id && !isReturning && needsWaiver) {
          try {
            // Get projectId from bill overview
            const ovRes = await fetch(
              `/api/sms?endpoint=bill%2Foverview&billId=${id}${getBookingClientKey() ? `&clientKey=${getBookingClientKey()}` : ""}`,
            );
            const ov = await ovRes.json();
            const projectId = ov.id || id;

            // Get projectReference from Office API
            const projRes = await fetch(`/api/bmi-office?action=project&id=${projectId}`);
            const proj = await projRes.json();
            if (proj.projectReference) {
              resolvedWaiverUrl = `https://kiosk.sms-timing.com/headpinzftmyers/subscribe/event?id=${encodeURIComponent(proj.projectReference)}`;
              setWaiverUrl(resolvedWaiverUrl);
            }
          } catch {
            /* non-fatal */
          }
        }

        // Claim POV codes if POV was purchased.
        //
        // Cascade overview sources — `overview` is the live BMI fetch
        // earlier in this function and is the authoritative state of
        // the bill. `parsedOverviews` is the pre-payment snapshot
        // saved by OrderSummary, which sometimes hasn't been written
        // yet for fast checkouts (Rookie Pack W33861, Ultimate
        // Qualifier W33835 both hit this). Looking ONLY at
        // parsedOverviews silently dropped the POV claim when
        // OrderSummary's save was racing with the confirmation page
        // load, leaving racers without their POV codes AND skipping
        // the BMI memo write below since both gate on
        // claimedPovCodes.length > 0.
        let claimedPovCodes: string[] = [];
        try {
          const claimSourceLines: OrderLine[] =
            overview?.lines && overview.lines.length > 0
              ? overview.lines
              : parsedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
          // BOTH POV product ids: the legacy $5 SKU (43746981) and the $0
          // build SKU (50361293) the zero-BMI-model checkout sells — packages
          // (Ultimate Qualifier, Rookie Pack) book POV under the $0 id, and
          // scanning only the legacy id silently skipped their claim.
          const povLine = claimSourceLines.find((l) =>
            ["43746981", "50361293"].includes(
              String((l as { productId?: string | number }).productId),
            ),
          );
          let povQty = povLine && povLine.quantity > 0 ? povLine.quantity : 0;
          // Package fallback — the live overview can be gone post-conversion
          // and the v2 checkout's stored overview is a synthetic summary with
          // no POV line. Any package with includesPov gets one POV per racer
          // (unique racers: UQ records one entry per heat, so "Adult 1" twice
          // is still one camera).
          if (povQty === 0) {
            const povPkgId = bookingRecord?.package as string | null | undefined;
            const povPkg = povPkgId
              ? getPackageIgnoreFlag(povPkgId)
              : bookingRecord?.rookiePack === true
                ? getPackageIgnoreFlag("rookie-pack")
                : null;
            if (povPkg?.includesPov) {
              const uniqueRacers = new Set(
                ((bookingRecord?.racers ?? []) as { personId?: string; racerName?: string }[])
                  .map((r) => r.personId || r.racerName)
                  .filter(Boolean),
              ).size;
              povQty = Math.max(1, uniqueRacers);
            }
          }
          if (povQty > 0) {
            const claimRes = await fetch(
              `/api/pov-codes?action=claim&qty=${povQty}&billId=${id}&email=${encodeURIComponent(details?.email || "")}`,
            );
            if (claimRes.ok) {
              const claimData = await claimRes.json();
              claimedPovCodes = claimData.codes || [];
              setPovCodes(claimedPovCodes);
              console.log("[POV codes] claimed:", claimedPovCodes);
            }
          } else {
            console.log("[POV codes] no POV line found in overview", {
              liveLines: overview?.lines?.length ?? 0,
              storedLines: claimSourceLines.length,
            });
          }
        } catch (err) {
          console.warn("[POV codes] claim failed:", err);
        }

        // Fire email + SMS confirmation (once per bill — prevent duplicates on revisit)
        const notifKey = `notif_sent_${id}`;
        if (notificationPayload && !sessionStorage.getItem(notifKey)) {
          sessionStorage.setItem(notifKey, "1");
          // Resolve location for venue/address picking + brand. The
          // booking-store wins because the user might have crossed
          // domains between booking and confirmation (e.g. Naples
          // booking that lands them on fasttraxent.com); the old
          // hostname-only check broke HeadPinz Naples emails.
          const storedLoc =
            typeof window !== "undefined" ? sessionStorage.getItem("bookingLocation") : null;
          const resolvedLocation =
            (details?.location as string | undefined) ||
            storedLoc ||
            (window.location.hostname.includes("headpinz") ? "headpinz" : "fasttrax");
          const isHpLoc = resolvedLocation === "headpinz" || resolvedLocation === "naples";

          // Multi-activity emails arrived near-blank: the BMI overview is gone
          // post-conversion and details.overviews carried only ONE activity's
          // lines (the bowling lines, stored with a `time` field, no
          // scheduledTime), so the schedule/date/time rows came out empty and
          // the gel-blaster activity was missing entirely. When the
          // overview-derived schedule is empty, rebuild the display schedule
          // from the authoritative booking record (every bowling/attraction/
          // racer activity with its time). scheduledItems is intentionally left
          // untouched so the racing sales-log participantCount math is
          // unaffected.
          if (!notificationPayload.reservationSchedule) {
            const norm = (t: string) =>
              t
                .replace(/Z$/, "")
                .replace(/[+-]\d{2}:\d{2}$/, "")
                .slice(0, 16);
            const recItems: { name: string; start: string }[] = [];
            for (const b of (bookingRecord?.bowling ?? []) as Array<{
              kind?: string;
              bookedAt?: string;
              date?: string;
            }>) {
              const t = b.bookedAt || (b.date ? `${b.date}T00:00:00` : "");
              if (t)
                recItems.push({ name: b.kind === "kbf" ? "Kids Bowl Free" : "Bowling", start: t });
            }
            for (const a of (bookingRecord?.attractions ?? []) as Array<{
              slug?: string;
              slot?: string;
              date?: string;
            }>) {
              const t = a.slot || (a.date ? `${a.date}T00:00:00` : "");
              if (t)
                recItems.push({
                  name: ATTRACTIONS[a.slug ?? ""]?.name ?? a.slug ?? "Activity",
                  start: t,
                });
            }
            const heatSeen = new Set<string>();
            for (const r of (bookingRecord?.racers ?? []) as Array<{
              product?: string;
              heatStart?: string;
            }>) {
              if (!r.heatStart) continue;
              const key = `${r.product || "Race"}|${r.heatStart}`;
              if (heatSeen.has(key)) continue;
              heatSeen.add(key);
              recItems.push({ name: r.product || "Race", start: r.heatStart });
            }
            if (recItems.length > 0) {
              recItems.sort((a, b) => norm(a.start).localeCompare(norm(b.start)));
              notificationPayload.reservationSchedule = recItems
                .map((s) => `${s.name} · ${formatTime(s.start)}`)
                .join("<br/>");
              notificationPayload.reservationDate = formatDate(recItems[0].start);
              notificationPayload.reservationTime = formatTime(recItems[0].start);
              notificationPayload.productNames = recItems.map((s) => s.name);
            }
          }

          fetch("/api/notifications/booking-confirmation", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...notificationPayload,
              waiverUrl: !isReturning ? resolvedWaiverUrl : "",
              isNewRacer: !isReturning,
              povCodes: claimedPovCodes,
              brand: isHpLoc ? "headpinz" : "fasttrax",
              location: resolvedLocation,
              expressLane: allWaiversValid,
              rookiePack: !!appetizerInfo,
              // Forward the packageId from the saved booking record so
              // sales_log captures it (Ultimate Qualifier, Rookie Pack,
              // future packages). Without this, /api/admin/sales/list
              // counts package bookings as 0 because rows are inserted
              // with package_id = NULL. The notifications endpoint
              // already accepts a `packageId` field — see
              // app/api/notifications/booking-confirmation/route.ts:161.
              packageId: (bookingRecord?.package as string | null | undefined) ?? undefined,
            }),
          }).catch(() => {});
        }

        // Combined reservation memo — ONE write per bill composing every
        // applicable note in priority order (Express Lane, booking URL, Ultimate
        // Qualifier, 3-race pack, POV codes, group reservations, amount paid).
        // BMI's booking/memo is a single OVERWRITING field, so the old separate
        // writes clobbered each other (v1's "3-pack overrode express lane" bug).
        if (allConfirmations.length > 0) {
          const memoQs = new URLSearchParams({
            endpoint: "booking/memo",
            ...(getBookingClientKey() ? { clientKey: getBookingClientKey()! } : {}),
          });
          const pkgId = bookingRecord?.package as string | null | undefined;
          const uqNote = pkgId
            ? (getPackageIgnoreFlag(pkgId)?.disclaimers?.billMemo ?? null)
            : null;
          // Combo special (Ultimate VIP): lead the memo with the VIP banner +
          // visit plan + assigned bowling lane (persisted to the booking record
          // by unified-reserve from QAMF). Written here — not server-side — so
          // it survives this single OVERWRITING booking/memo write.
          const comboId = bookingRecord?.comboSpecial as string | null | undefined;
          const combo = comboId ? getComboSpecial(comboId) : null;
          const comboLane = (bookingRecord?.bowlingLane as string | null | undefined) ?? null;
          // Reorder fallback (stamped by unified-reserve when the lane ran after
          // both races): describe the visit plan in the order it actually runs.
          const comboReordered = (bookingRecord?.comboReorder as boolean | undefined) ?? false;
          const comboNote = combo
            ? comboReservationNote(
                combo,
                comboLane,
                comboReordered ? combo.fallbackComponents : undefined,
              )
            : null;
          const memoLines: OrderLine[] =
            overview?.lines && overview.lines.length > 0
              ? overview.lines
              : parsedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
          const isThreePack = memoLines.some((l) => /3[\s-]?(race[\s-]?)?pack/i.test(l.name));
          const origin = typeof window !== "undefined" ? window.location.origin : "";
          // Resolve the canonical short link (/s/{code}) per bill so the memo's
          // Booking: line matches the link the customer gets by email/SMS and
          // the one the admin board opens. Minted server-side (needs the HMAC
          // secret); falls back to the raw billId URL so a memo is never linkless.
          const shortLinks = new Map<string, string>();
          await Promise.all(
            allConfirmations.map(async (c) => {
              try {
                const linkRes = await fetch(
                  `/api/booking/confirmation-link?billId=${c.billId}&v2=1`,
                );
                if (linkRes.ok) {
                  const { shortUrl } = await linkRes.json();
                  if (shortUrl) shortLinks.set(c.billId, shortUrl);
                }
              } catch {
                /* fall back to the raw billId URL below */
              }
            }),
          );
          for (const conf of allConfirmations) {
            const related = allConfirmations
              .filter((c) => c.billId !== conf.billId && c.resNumber)
              .map((c) => `${c.resNumber} (${c.racerName})`)
              .join(", ");
            const memo = buildReservationMemo({
              comboNote: conf.billId === id ? comboNote : null,
              expressLaneResNumber: allWaiversValid ? conf.resNumber : null,
              bookingUrl:
                shortLinks.get(conf.billId) ??
                (origin ? `${origin}/book/confirmation/v2?billId=${conf.billId}` : null),
              ultimateQualifierNote: uqNote,
              isThreeRacePack: isThreePack,
              povCodes: conf.billId === id ? claimedPovCodes : [],
              relatedReservations: related || null,
              amountPaid: amount > 0 ? amount : null,
            });
            if (!memo) continue;
            try {
              // Raw-inject the bill id (17-digit bigint — NEVER Number() /
              // JSON.stringify it) and JSON-escape only the memo string. Mirrors
              // race.ts writeBillMemo. One write per bill = nothing overrides.
              await fetch(`/api/bmi?${memoQs.toString()}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: `{"orderId":${conf.billId},"memo":${JSON.stringify(memo)}}`,
              });
            } catch {
              /* non-fatal */
            }
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
            lines: details.race
              ? [
                  {
                    name: details.race,
                    quantity: parseFloat(details.qty || "1"),
                    totalPrice: [{ amount: parseFloat(details.amount || "0"), depositKind: 0 }],
                    // Only racing bookings (racers on record) are "Karting".
                    // details.race holds the bowling/attraction description when
                    // there's no live overview — defaulting it to "Karting"
                    // synthesized a phantom racing activity.
                    productGroup:
                      details?.attraction || (bookingRecord?.racers?.length ? "Karting" : "Other"),
                    scheduledTime: details.heat ? { start: details.heat, stop: "" } : undefined,
                  },
                ]
              : [],
          });
        }

        // Itemized day-of Square receipt — "exactly what you paid for". Pulled
        // from the authoritative Square day-of order (resolved server-side from
        // the reservation row). Non-fatal — falls back to the overviews below.
        let receiptLoaded = false;
        try {
          const rcptQs = new URLSearchParams({ billId: id! });
          const code = params.get("code");
          if (code) rcptQs.set("code", code);
          const rcptRes = await fetch(`/api/booking/v2/receipt?${rcptQs.toString()}`);
          if (rcptRes.ok) {
            const rcpt = await rcptRes.json();
            if (rcpt.available) {
              setReceipt(rcpt as ReceiptData);
              receiptLoaded = true;
            }
          }
        } catch {
          /* fall through to the overview-based fallback */
        }

        // Fallback receipt — bookings with no Square day-of order (the racing
        // checkout path predates the unified reserve flow, so it never creates
        // a reservation row) still get the "What you paid for" card, rebuilt
        // from the live BMI overview or the pre-payment stored overviews.
        // Note the two line shapes: live BMI lines carry totalPrice[] (cash =
        // depositKind 0); stored OrderSummary lines carry a flat `amount`.
        if (!receiptLoaded) {
          try {
            const cash = (arr?: { amount: number; depositKind: number }[]) =>
              arr?.find((t) => t.depositKind === 0)?.amount ?? 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const srcOverviews: any[] = overview?.lines?.length ? [overview] : parsedOverviews;
            const lineItems = srcOverviews
              .flatMap((ov) =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (ov.lines || []).map((l: any) => ({
                  name: displayLineName({
                    productId: l.productId ?? l.bmiProductId,
                    name: l.name || "Item",
                  }),
                  quantity: Number(l.quantity) || 1,
                  amountCents: Math.round((cash(l.totalPrice) || Number(l.amount) || 0) * 100),
                })),
              )
              .filter((l) => l.amountCents > 0);
            const totalCents = Math.round(
              srcOverviews.reduce((s, ov) => s + cash(ov.total), 0) * 100,
            );
            const taxCents = Math.round(
              srcOverviews.reduce((s, ov) => s + cash(ov.totalTax), 0) * 100,
            );
            const paidOnlineCents = Math.round(amount * 100);
            // Credit-paid orders charged $0 online but owe nothing at the center.
            const isCredit = details?.isCreditOrder === "true";
            if (lineItems.length > 0 && totalCents > 0) {
              setReceipt({
                lineItems,
                discounts: [],
                discountCents: 0,
                taxCents,
                totalCents,
                paidOnlineCents,
                dueAtCenterCents: isCredit ? 0 : Math.max(0, totalCents - paidOnlineCents),
              });
            }
          } catch {
            /* card simply omitted */
          }
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
          window.history.replaceState({}, "", `/book/confirmation/v2`);
        } else {
          window.history.replaceState({}, "", `/book/confirmation/v2?billId=${id}`);
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
    QRCode.toDataURL(reservationCode, {
      width: 200,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [reservationCode]);

  // Reset scroll to top when entering an activity detail or returning to the
  // hub — these are client-side view swaps, so the browser keeps the prior
  // scroll position without this.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [selectedActivity]);

  // Extract data from order — find the first scheduled line (racing or attraction)
  const raceLine = order?.lines.find((l) => l.scheduledTime?.start || l.schedules?.[0]?.start);
  const start =
    raceLine?.scheduledTime?.start ||
    raceLine?.schedules?.[0]?.start ||
    order?.scheduleDays?.[0]?.schedules?.[0]?.start ||
    order?.date ||
    null;

  // ── Multi-activity hub (v2) ──────────────────────────────────────
  // Enumerate the booking's activities so we can show a hub of buttons
  // (sorted by start time) when there's more than one. Racing is ONE
  // activity (earliest heat); each attraction and each bowling/kbf item
  // is its own. Times come straight from the booking record persisted at
  // checkout (saveBookingDetails).
  const attractionList = (bookingRec?.attractions ?? []) as Array<{
    slug?: string;
    date?: string;
    slot?: string;
    qty?: number;
    price?: number;
  }>;
  const bowlingList = (bookingRec?.bowling ?? []) as Array<{
    kind?: string;
    date?: string;
    bookedAt?: string;
    experienceSlug?: string;
    laneCount?: number;
    playerCount?: number;
    qamfReservationId?: string;
  }>;
  // Racing is present only when the booking record actually has racers (→
  // raceGroups). The BMI-overview "Karting" heuristic is a fallback ONLY for
  // bookings with no enumerable record activities (legacy/seeded racing orders).
  // It must NOT fire for bowling/attraction bookings: BMI tags some attraction
  // lines as "Karting", and the synthetic fallback order line (built from
  // details.race when the live overview is gone) hardcodes "Karting" — both
  // produced a phantom "Racing" activity on bowling+gel-blaster bookings.
  const recActivityCount =
    (bookingRec?.racers?.length ?? 0) + attractionList.length + bowlingList.length;
  const hasRacing =
    raceGroups.length > 0 ||
    (recActivityCount === 0 && (order?.lines?.some((l) => l.productGroup === "Karting") ?? false));
  const racingTime =
    raceGroups[0]?.heatStart ||
    order?.lines?.find((l) => l.productGroup === "Karting" && l.scheduledTime?.start)?.scheduledTime
      ?.start ||
    start ||
    "";
  // Compare on ET wall-clock minute — heatStart is naked-local, slot &
  // bookedAt carry an offset, so strip tz before comparing.
  const timeKey = (t: string) =>
    t
      ? t
          .replace(/Z$/, "")
          .replace(/[+-]\d{2}:\d{2}$/, "")
          .slice(0, 16)
      : "";
  type Activity = { kind: "racing" | "attraction" | "bowling"; index: number; time: string };
  type ActivityRef = Pick<Activity, "kind" | "index">;
  const activities: Activity[] = [
    ...(hasRacing ? [{ kind: "racing" as const, index: 0, time: racingTime }] : []),
    ...attractionList.map((a, i) => ({
      kind: "attraction" as const,
      index: i,
      time: a.slot || (a.date ? `${a.date}T00:00:00` : ""),
    })),
    ...bowlingList.map((b, i) => ({
      kind: "bowling" as const,
      index: i,
      time: b.bookedAt || (b.date ? `${b.date}T00:00:00` : ""),
    })),
  ].sort((a, b) => timeKey(a.time).localeCompare(timeKey(b.time)));
  const isMulti = activities.length > 1;
  const isDetail = isMulti && selectedActivity !== null;
  // Which sections render: single-activity bookings show everything (v1
  // parity); multi-activity detail views show only the chosen activity.
  const showRacing = (!isMulti && hasRacing) || (isDetail && selectedActivity!.kind === "racing");
  const attractionsToShow = !isMulti
    ? attractionList
    : isDetail && selectedActivity!.kind === "attraction"
      ? [attractionList[selectedActivity!.index]]
      : [];
  const bowlingToShow = !isMulti
    ? bowlingList
    : isDetail && selectedActivity!.kind === "bowling"
      ? [bowlingList[selectedActivity!.index]]
      : [];

  // ── Activity display config (photos, labels, address) ────────────
  // Pull per-activity photo + branding from the shared ATTRACTIONS map
  // (same source the attraction-select screen uses) so each card/detail
  // is photo-rich and clearly labeled.
  const BLUE_TRACK =
    "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg";
  const ATTR_ADDR: Record<string, string> = {
    fasttrax: "14501 Global Parkway, Fort Myers",
    headpinz: "14513 Global Parkway, Fort Myers",
    naples: "8525 Radio Ln, Naples",
  };
  const activityCfg = (act: ActivityRef | null): AttractionConfig | null => {
    if (!act) return null;
    if (act.kind === "racing") return ATTRACTIONS["racing"] ?? null;
    if (act.kind === "attraction")
      return ATTRACTIONS[attractionList[act.index]?.slug ?? ""] ?? null;
    return (
      ATTRACTIONS[bowlingList[act.index]?.kind === "kbf" ? "kids-bowl-free" : "bowling"] ?? null
    );
  };
  // Bowling always reads "Bowling" (never the experience name); KBF stays distinct.
  const activityLabel = (act: ActivityRef | null): string => {
    if (!act) return "";
    if (act.kind === "racing") return "Racing";
    if (act.kind === "attraction") return activityCfg(act)?.name ?? "Activity";
    return bowlingList[act.index]?.kind === "kbf" ? "Kids Bowl Free" : "Bowling";
  };
  const activityAddress = (cfg: AttractionConfig | null): string => {
    if (!cfg) return ATTR_ADDR.headpinz;
    const loc = cfg.location === "both" ? "headpinz" : cfg.location;
    return ATTR_ADDR[loc] ?? ATTR_ADDR.headpinz;
  };

  // Hero shows the active activity's photo (detail or single-activity);
  // the multi-activity hub keeps the neutral track hero.
  const heroActivity: ActivityRef | null = isDetail
    ? selectedActivity
    : !isMulti
      ? (activities[0] ?? null)
      : null;
  const heroCfg = activityCfg(heroActivity);
  const heroImageUrl = heroCfg?.heroImage || BLUE_TRACK;
  const heroIsRacing = heroActivity ? heroActivity.kind === "racing" : bookingType === "racing";
  const heroTitle = heroIsRacing ? "You're on the grid!" : "You're booked!";

  // Combo special: stamped on the booking record at checkout
  // (saveBookingDetails → comboSpecial). Drives the celebratory banner.
  const comboSpecialId = (bookingRec?.comboSpecial as string | null | undefined) ?? null;
  const comboSpecial = comboSpecialId ? getComboSpecial(comboSpecialId) : null;

  return (
    <div className="min-h-screen bg-[#000418]">
      {expressLane && (
        <style>{`
          @keyframes expressGlow {
            0%, 100% { box-shadow: 0 0 15px rgba(16,185,129,0.3), 0 0 30px rgba(16,185,129,0.15), 0 0 60px rgba(16,185,129,0.05); border-color: rgba(16,185,129,0.5); }
            33% { box-shadow: 0 0 40px rgba(16,185,129,0.8), 0 0 80px rgba(16,185,129,0.4), 0 0 140px rgba(16,185,129,0.2); border-color: rgba(16,185,129,1); }
            66% { box-shadow: 0 0 25px rgba(16,185,129,0.5), 0 0 60px rgba(16,185,129,0.25), 0 0 100px rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.7); }
          }
        `}</style>
      )}
      {/* Hero banner */}
      <div className="relative overflow-hidden">
        <Image
          src={heroImageUrl}
          alt={activityLabel(heroActivity) || "FastTrax Racing"}
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
              <Link href="/book" className="text-[#00E2E5] underline">
                Book an experience
              </Link>
            </div>
          ) : confirmFailed ? (
            <div className="space-y-4 max-w-md mx-auto">
              <div className="w-20 h-20 rounded-full bg-amber-500/20 border-2 border-amber-500/50 flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-10 h-10 text-amber-400"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                  />
                </svg>
              </div>
              <h1 className="text-3xl md:text-4xl font-display uppercase tracking-widest text-white mb-2">
                Almost there
              </h1>
              <p className="text-white/70 text-sm">
                Your payment went through but we had trouble finalizing your reservation. Your seats
                are held — please tap below to retry or see the front desk when you arrive.
              </p>
              <button
                onClick={() => {
                  setConfirmFailed(false);
                  confirmStarted.current = false;
                  setLoading(true);
                  window.location.reload();
                }}
                className="mt-2 inline-block px-6 py-3 bg-[#00E2E5] text-black font-bold rounded-lg hover:bg-[#00E2E5]/80 transition"
              >
                Retry Confirmation
              </button>
            </div>
          ) : (
            <>
              <div className="w-20 h-20 rounded-full bg-[#00E2E5]/20 border-2 border-[#00E2E5]/50 flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-10 h-10 text-[#00E2E5]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-4xl md:text-5xl font-display uppercase tracking-widest text-white mb-2">
                {heroTitle}
              </h1>
              {comboSpecial && (
                <p
                  className="mx-auto mb-2 inline-block rounded-full border px-4 py-1.5 font-display text-sm uppercase tracking-widest sm:text-base"
                  style={{
                    color: comboSpecial.accentColor,
                    borderColor: comboSpecial.accentColor,
                    backgroundColor: "rgba(7,16,39,0.6)",
                  }}
                >
                  You booked the {comboSpecial.name}!
                </p>
              )}
              {heroActivity && !comboSpecial && (
                <p
                  className="font-display text-lg sm:text-xl uppercase tracking-widest mb-1"
                  style={{ color: heroCfg?.color ?? "#00E2E5" }}
                >
                  {activityLabel(heroActivity)}
                </p>
              )}
              <p className="text-white/50 text-sm max-w-md mx-auto">
                Your reservation is confirmed. Show your QR code at check-in when you arrive.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Main content */}
      {!loading && orderId && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-16 pt-6">
          {/* Add more guests to a VIP combo (flag-gated via combo.addon.enabled).
              Shown on the hub, not inside a single-activity detail view. */}
          {comboSpecial && comboAddonEnabled(comboSpecial) && !isDetail && orderId && (
            <AddGuestsCard
              billId={orderId}
              comboName={comboSpecial.name}
              accentColor={comboSpecial.accentColor}
            />
          )}
          {/* Multi-activity detail view — back to the hub of buttons */}
          {isDetail && (
            <button
              type="button"
              onClick={() => setSelectedActivity(null)}
              className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-white/60 transition-colors hover:text-white"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              All bookings
            </button>
          )}

          {/* Waiver banner — new racers or attractions that require waivers.
              Wrapped in max-w-2xl so it visually aligns with the reservation
              card directly below it. The page outer is max-w-6xl, but the
              reservation card group inside uses max-w-2xl for the single-
              reservation case (the dominant flow), so anchoring the banner
              there keeps the column edges consistent.
              `!isDetail`: show this prominent action-required banner only on the
              main view (the multi-activity hub and single-activity bookings),
              not when the guest has drilled into one activity's detail — the
              main page is enough. (Attraction detail views keep their own small
              per-attraction reminder via cfg.showWaiverPrompt.) */}
          {waiverUrl && !expressLane && !isDetail && (
            <div className="max-w-2xl mx-auto rounded-2xl border-2 border-red-500/60 bg-gradient-to-br from-red-500/15 via-red-500/5 to-transparent p-5 sm:p-6 mb-8 shadow-[0_0_30px_rgba(239,68,68,0.15)]">
              <div className="flex items-start gap-4 mb-4">
                <div className="w-14 h-14 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center shrink-0 animate-pulse">
                  <svg
                    className="w-7 h-7 text-red-400"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-red-400 text-xs font-bold uppercase tracking-widest">
                    Action Required
                  </p>
                  <h2 className="text-white font-display text-xl sm:text-2xl uppercase tracking-wider mt-1">
                    Complete Your Waiver
                  </h2>
                </div>
              </div>
              <p className="text-white/80 text-sm leading-relaxed mb-4 max-w-2xl">
                <strong className="text-red-400">
                  Every guest must complete their own waiver before participating.
                </strong>{" "}
                Each person in your party needs to sign individually. Parents or guardians must
                register themselves first, then add any minors to their waiver.
              </p>
              <a
                href={waiverUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base bg-red-500 text-white hover:bg-red-400 transition-colors shadow-lg shadow-red-500/30"
              >
                Complete Waiver Now
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
              <p className="text-white/40 text-xs mt-3">
                Opens in a new tab. Each participant signs their own waiver. Parents: register
                yourself first, then add your minors.
              </p>
            </div>
          )}

          {/* What you paid for — itemized day-of Square order. Shown once on the
              main view (hub + single-activity), not inside a per-activity detail. */}
          {!isDetail && receipt && receipt.lineItems.length > 0 && (
            <div className="max-w-2xl mx-auto rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6 mb-8">
              <h2 className="font-display text-lg uppercase tracking-widest text-white mb-3">
                What you paid for
              </h2>
              <ul className="space-y-1.5 text-sm">
                {receipt.lineItems.map((li, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-white/70">
                      {li.name}
                      {li.quantity > 1 && <span className="text-white/40"> ×{li.quantity}</span>}
                    </span>
                    <span className="tabular-nums text-white/70">
                      ${(li.amountCents / 100).toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
              {receipt.discounts.map((d, i) => (
                <div key={i} className="mt-1.5 flex justify-between gap-3 text-sm">
                  <span className="text-emerald-400">{d.name}</span>
                  <span className="tabular-nums text-emerald-400">
                    −${(d.amountCents / 100).toFixed(2)}
                  </span>
                </div>
              ))}
              {receipt.taxCents > 0 && (
                <div className="mt-1.5 flex justify-between gap-3 text-sm">
                  <span className="text-white/50">Tax</span>
                  <span className="tabular-nums text-white/50">
                    ${(receipt.taxCents / 100).toFixed(2)}
                  </span>
                </div>
              )}
              <div className="mt-3 flex justify-between gap-3 border-t border-white/10 pt-3 text-sm font-semibold">
                <span className="text-white">Total</span>
                <span className="tabular-nums text-white">
                  ${(receipt.totalCents / 100).toFixed(2)}
                </span>
              </div>
              {receipt.paidOnlineCents > 0 && (
                <div className="mt-1 flex justify-between gap-3 text-xs text-white/50">
                  <span>Paid online today</span>
                  <span className="tabular-nums">
                    ${(receipt.paidOnlineCents / 100).toFixed(2)}
                  </span>
                </div>
              )}
              {receipt.dueAtCenterCents > 0 && (
                <div className="mt-0.5 flex justify-between gap-3 text-xs text-white/50">
                  <span>Balance due at check-in</span>
                  <span className="tabular-nums">
                    ${(receipt.dueAtCenterCents / 100).toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Multi-activity hub — one button per activity, sorted by start
              time. Single-activity bookings skip the hub and render as v1. */}
          {isMulti && selectedActivity === null ? (
            <div className="max-w-3xl mx-auto">
              {/* Overview header — signals this is the full booking summary */}
              <div className="text-center mb-6">
                <h2 className="font-display text-2xl sm:text-3xl uppercase tracking-widest text-white">
                  Your Experience
                </h2>
                <p className="text-white/40 text-sm mt-1">
                  {activities.length} activities booked · tap any to view details
                </p>
              </div>
              {/* First stop — the earliest activity tells the guest where to
                  start (which building/desk to go to first). */}
              {(() => {
                const first = activities[0];
                if (!first) return null;
                const cfg = activityCfg(first);
                // Non-express racers must arrive 30 min early for Guest Services
                // check-in. When racing is the first stop and the party isn't on
                // the express lane, the actionable arrival time is that check-in
                // time (heat − 30 min), not the heat start.
                const racingFirstNoExpress =
                  first.kind === "racing" && !expressLane && !!first.time;
                return (
                  <div className="max-w-2xl mx-auto mb-6 rounded-2xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-5 flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl bg-[#00E2E5]/15 flex items-center justify-center shrink-0">
                      <svg
                        className="w-6 h-6 text-[#00E2E5]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[#00E2E5] text-xs font-bold uppercase tracking-widest">
                        Start here · First stop
                      </p>
                      <p className="text-white font-display text-xl sm:text-2xl uppercase tracking-wide mt-1">
                        {cfg?.building ?? "HeadPinz"}
                      </p>
                      <p className="text-white/70 text-sm sm:text-base">{activityAddress(cfg)}</p>
                      <p className="text-white text-sm sm:text-base font-semibold mt-2">
                        {activityLabel(first)}
                        {first.time ? (
                          <span className="text-[#00E2E5]">
                            {" · "}
                            {racingFirstNoExpress
                              ? `Arrive by ${checkinTime(first.time)}`
                              : formatTime(first.time)}
                          </span>
                        ) : (
                          ""
                        )}
                      </p>
                      {racingFirstNoExpress && (
                        <p className="text-amber-300 text-xs sm:text-sm font-semibold mt-1.5 flex items-start gap-1.5">
                          <svg
                            className="w-4 h-4 shrink-0 mt-0.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                          <span>
                            Check-in opens 30 minutes early — arrive by {checkinTime(first.time)}{" "}
                            for your {formatTime(first.time)} heat.
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
              <div className="grid sm:grid-cols-2 gap-4">
                {activities.map((act) => {
                  const cfg = activityCfg(act);
                  const a = act.kind === "attraction" ? attractionList[act.index] : null;
                  const b = act.kind === "bowling" ? bowlingList[act.index] : null;
                  const label = activityLabel(act);
                  const dateSrc = act.kind === "racing" ? null : a?.date || b?.date || null;
                  const dateStr =
                    act.kind === "racing"
                      ? act.time
                        ? formatDate(act.time)
                        : ""
                      : dateSrc
                        ? formatDate(`${dateSrc}T12:00:00`)
                        : "";
                  const timeStr =
                    act.kind === "racing"
                      ? act.time
                        ? formatTime(act.time)
                        : ""
                      : act.kind === "attraction"
                        ? a?.slot
                          ? new Date(a.slot.replace(/Z$/, "")).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                              hour12: true,
                            })
                          : ""
                        : b?.bookedAt
                          ? new Date(b.bookedAt).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                              hour12: true,
                              timeZone: "America/New_York",
                            })
                          : "";
                  const accent = cfg?.color ?? "#00E2E5";
                  return (
                    <button
                      key={`${act.kind}-${act.index}`}
                      type="button"
                      onClick={() => setSelectedActivity({ kind: act.kind, index: act.index })}
                      className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-left transition-all hover:bg-white/[0.06]"
                    >
                      {/* Activity photo */}
                      <div className="relative aspect-[16/10] overflow-hidden">
                        {cfg?.heroImage && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={cfg.heroImage}
                            alt={label}
                            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-[#000418] via-[#000418]/30 to-transparent" />
                        <p
                          className="absolute bottom-3 left-4 right-4 font-display text-xl sm:text-2xl font-black uppercase tracking-wider text-white"
                          style={{ textShadow: "0 2px 8px rgba(0,0,0,0.7)" }}
                        >
                          {label}
                        </p>
                      </div>
                      {/* Meta row */}
                      <div className="flex items-center justify-between gap-3 p-4">
                        <div className="min-w-0">
                          {dateStr && <p className="text-white/70 text-sm">{dateStr}</p>}
                          <p className="text-white/40 text-xs mt-0.5">
                            {timeStr ? `${timeStr} · ` : ""}
                            {cfg?.building ?? "HeadPinz"}
                          </p>
                        </div>
                        <span
                          className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider shrink-0"
                          style={{ color: accent }}
                        >
                          View
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </span>
                      </div>
                      <div className="h-0.5 w-full" style={{ backgroundColor: accent }} />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              {/* Layout: single reservation = full-width card then two-col journey below.
              Multiple = cards left, journey right */}
              <div className="mb-8">
                {showRacing && (
                  <div
                    className={`${expressLane && raceGroups.length > 1 ? "grid md:grid-cols-2 gap-6" : "max-w-2xl mx-auto"} space-y-6 md:space-y-0`}
                  >
                    {/* Express Check-In directions — full-width banner above the
                        per-heat tiles (md:col-span-2 keeps it from landing in a
                        grid cell beside a racer tile). */}
                    {expressLane && raceGroups.length > 0 && (
                      <div
                        className="md:col-span-2 max-w-2xl mx-auto mb-6 rounded-2xl overflow-hidden border-2 border-emerald-400 animate-[expressGlow_3s_ease-in-out_infinite]"
                        style={{
                          background:
                            "linear-gradient(135deg, rgba(16,185,129,0.12), rgba(16,185,129,0.04))",
                          boxShadow:
                            "0 0 30px rgba(16,185,129,0.25), 0 0 60px rgba(16,185,129,0.1)",
                        }}
                      >
                        <div className="px-6 py-5 space-y-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-emerald-500/25 flex items-center justify-center shrink-0">
                              <svg
                                className="w-5 h-5 text-emerald-400"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M13 10V3L4 14h7v7l9-11h-7z"
                                />
                              </svg>
                            </div>
                            <p className="text-emerald-400 text-base sm:text-lg font-bold uppercase tracking-widest">
                              Express Lane
                            </p>
                          </div>
                          {/* Skip these */}
                          <div className="flex flex-wrap gap-2">
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/30">
                              <svg
                                className="w-3.5 h-3.5 text-red-400"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M6 18L18 6M6 6l12 12"
                                />
                              </svg>
                              <span className="text-red-400 text-xs font-bold line-through">
                                Guest Services
                              </span>
                            </span>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/30">
                              <svg
                                className="w-3.5 h-3.5 text-red-400"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M6 18L18 6M6 6l12 12"
                                />
                              </svg>
                              <span className="text-red-400 text-xs font-bold line-through">
                                Event Check-In
                              </span>
                            </span>
                          </div>
                          {/* Go here */}
                          <div className="flex items-center gap-2">
                            <svg
                              className="w-6 h-6 text-emerald-400 shrink-0"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M13 7l5 5m0 0l-5 5m5-5H6"
                              />
                            </svg>
                            <p className="text-emerald-400 text-lg sm:text-xl font-black uppercase tracking-wide">
                              Head straight to Karting!
                            </p>
                          </div>
                          <p className="text-white/50 text-sm">
                            1st Floor — Arrive 5 min before your race. Please have your e-ticket
                            open and ready.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Express lane: grouped tiles per heat. Standard: original QR card layout */}
                    {expressLane && raceGroups.length > 0
                      ? (() => {
                          return raceGroups.map((group, gi) => {
                            const trackName =
                              group.track === "Red"
                                ? "Red Track"
                                : group.track === "Blue"
                                  ? "Blue Track"
                                  : group.track === "Mega"
                                    ? "Mega Track"
                                    : null;
                            const trackColor =
                              group.track === "Red"
                                ? "#E53935"
                                : group.track === "Blue"
                                  ? "#004AAD"
                                  : group.track === "Mega"
                                    ? "#8B5CF6"
                                    : "#00E2E5";
                            const qr = racerQrCodes[group.billId] || qrDataUrl;

                            // Match this card's booked heat to live checking-in status
                            const trackKey = (group.track || "").toLowerCase() as
                              | "blue"
                              | "red"
                              | "mega";
                            const liveRace = currentRaces?.[trackKey] ?? null;
                            const isMyHeat = !!(
                              liveRace?.scheduledStart &&
                              group.heatStart &&
                              liveRace.scheduledStart
                                .replace(/Z$/, "")
                                .startsWith(group.heatStart.replace(/Z$/, "").slice(0, 16))
                            );

                            return (
                              <div
                                key={gi}
                                className={`rounded-2xl overflow-hidden ${
                                  expressLane
                                    ? "border-2 border-emerald-400 animate-[expressGlow_3s_ease-in-out_infinite]"
                                    : "border border-white/10 bg-white/[0.03]"
                                }`}
                                style={
                                  expressLane
                                    ? {
                                        background:
                                          "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.02))",
                                        boxShadow:
                                          "0 0 20px rgba(16,185,129,0.15), 0 0 40px rgba(16,185,129,0.07)",
                                      }
                                    : undefined
                                }
                              >
                                {/* Main content */}
                                <div className="p-5 sm:p-6">
                                  {/* YOUR HEAT banner — shows when this card matches the live checking-in heat */}
                                  {isMyHeat && (
                                    <div className="mb-3 rounded-lg bg-amber-500/20 border border-amber-500/50 px-4 py-2">
                                      <p className="text-amber-400 font-bold text-sm uppercase tracking-wider text-center">
                                        🏁 Your Heat Is Now Checking In!
                                      </p>
                                    </div>
                                  )}

                                  {/* Track badge — top: "Mega Starter 47" or "Blue Pro 55" */}
                                  {trackName &&
                                    (() => {
                                      const raceType = /pro/i.test(group.product)
                                        ? "Pro"
                                        : /intermediate/i.test(group.product)
                                          ? "Intermediate"
                                          : "Starter";
                                      const heatNum = group.heatName?.match(/\d+/)?.[0] || "";
                                      return (
                                        <div className="mb-3">
                                          <span
                                            className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full"
                                            style={{
                                              color: trackColor,
                                              backgroundColor: `${trackColor}20`,
                                              border: `1px solid ${trackColor}40`,
                                            }}
                                          >
                                            {group.track || "Race"} {raceType}
                                            {heatNum ? ` ${heatNum}` : ""}
                                          </span>
                                        </div>
                                      );
                                    })()}

                                  {/* Racer names — big */}
                                  <div>
                                    {group.racers.map((name, ri) => (
                                      <p
                                        key={ri}
                                        className="text-white font-display uppercase tracking-wider leading-none"
                                        style={{ fontSize: "clamp(36px, 10vw, 60px)" }}
                                      >
                                        {name}
                                      </p>
                                    ))}
                                  </div>

                                  {/* Time */}
                                  {group.heatStart && (
                                    <div className="mt-3">
                                      {expressLane ? (
                                        <>
                                          <p className="text-emerald-400 text-xs font-bold uppercase tracking-wider">
                                            Race Time
                                          </p>
                                          <p
                                            className="text-white font-display uppercase tracking-wider leading-none"
                                            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
                                          >
                                            {formatTime(group.heatStart)}
                                          </p>
                                          <p className="text-emerald-400/60 text-xs mt-1">
                                            Arrive 5 min before — go straight to Karting, 1st Floor
                                          </p>
                                        </>
                                      ) : (
                                        <>
                                          <p className="text-red-400 text-xs font-bold uppercase tracking-wider">
                                            Check In By
                                          </p>
                                          <p className="text-white font-display text-3xl sm:text-4xl uppercase tracking-widest">
                                            {checkinTime(group.heatStart)}
                                          </p>
                                          <p className="text-white/30 text-xs">
                                            {checkInLocation === "fasttrax"
                                              ? "FastTrax — Guest Services, 2nd Floor"
                                              : "HeadPinz — Guest Services"}
                                          </p>
                                        </>
                                      )}
                                    </div>
                                  )}

                                  {/* Date, address, reservation number — bottom */}
                                  {group.heatStart && (
                                    <p className="text-white/40 text-xs mt-2">
                                      {formatDate(group.heatStart)}
                                    </p>
                                  )}
                                  <p className="text-white/20 text-xs">
                                    14501 Global Parkway, Fort Myers
                                  </p>
                                  <p
                                    className={`font-bold text-xs mt-2 ${expressLane ? "text-emerald-400/50" : "text-[#00E2E5]/50"}`}
                                  >
                                    {group.resNumber}
                                  </p>
                                </div>

                                {/* QR (non-express: reservation QR, express: check-in QR per racer) */}
                                {qr && !expressLane && (
                                  <div className="border-t border-white/[0.06] px-5 py-4 flex justify-center">
                                    <button
                                      className="cursor-pointer"
                                      onClick={() =>
                                        setFullscreenQr({ src: qr, resNumber: group.resNumber })
                                      }
                                    >
                                      <div className="rounded-lg bg-white p-1.5 hover:shadow-lg hover:shadow-[#00E2E5]/20 transition-shadow">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                          src={qr}
                                          alt={`QR ${group.resNumber}`}
                                          width={100}
                                          height={100}
                                          className="w-[80px] h-[80px]"
                                        />
                                      </div>
                                      <p className="text-white/20 text-xs text-center mt-1">
                                        Tap to enlarge
                                      </p>
                                    </button>
                                  </div>
                                )}

                                {/* Express lane: check-in QR per racer */}
                                {expressLane &&
                                  group.racerDetails.some(
                                    (r) => r.personId && checkinQrByPerson[r.personId],
                                  ) && (
                                    <div className="border-t border-emerald-400/20 px-5 py-4">
                                      <p className="text-emerald-400/60 text-xs font-bold uppercase tracking-wider text-center mb-3">
                                        Check-In QR
                                      </p>
                                      <div className="flex justify-center gap-4 flex-wrap">
                                        {group.racerDetails.map((rd, ri) => {
                                          const qrUrl = rd.personId
                                            ? checkinQrByPerson[rd.personId]
                                            : null;
                                          if (!qrUrl) return null;
                                          return (
                                            <button
                                              key={ri}
                                              type="button"
                                              className="flex flex-col items-center gap-1 cursor-pointer"
                                              onClick={() =>
                                                setFullscreenQr({ src: qrUrl, resNumber: rd.name })
                                              }
                                            >
                                              <div className="rounded-lg bg-white p-2 hover:shadow-lg hover:shadow-emerald-400/30 transition-shadow">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                  src={qrUrl}
                                                  alt={`QR ${rd.name}`}
                                                  width={140}
                                                  height={140}
                                                  className="w-[120px] h-[120px]"
                                                />
                                              </div>
                                              <p className="text-white/60 text-xs text-center font-semibold">
                                                {rd.name}
                                              </p>
                                              <p className="text-white/20 text-[10px] text-center">
                                                Tap to enlarge
                                              </p>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}
                              </div>
                            );
                          });
                        })()
                      : (() => {
                          // Fallback: original confirmation-based cards (no booking record)
                          const cards =
                            confirmations.length > 0
                              ? confirmations
                              : [
                                  {
                                    billId: orderId || "",
                                    racerName: "",
                                    resNumber: reservationNumber || "",
                                    resCode: reservationCode || "",
                                  },
                                ];
                          return cards.map((c, ci) => {
                            const qr = racerQrCodes[c.billId] || qrDataUrl;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const ov =
                              storedOverviews.find(
                                (o: any) => o._billId === c.billId || o.id === c.billId,
                              ) || (ci === 0 ? order : null);
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const lines = (ov?.lines || []) as any[];
                            const firstHeat = lines.find(
                              (l: {
                                scheduledTime?: { start: string };
                                schedules?: { start: string }[];
                              }) => l.scheduledTime?.start || l.schedules?.[0]?.start,
                            );
                            const heatStart =
                              firstHeat?.scheduledTime?.start ||
                              firstHeat?.schedules?.[0]?.start ||
                              start;

                            return (
                              <div
                                key={c.billId || ci}
                                className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden"
                              >
                                <div className="p-4 sm:p-8 flex items-center gap-6">
                                  {qr && (
                                    <button
                                      className="shrink-0 cursor-pointer"
                                      onClick={() =>
                                        setFullscreenQr({
                                          src: qr,
                                          resNumber: c.resNumber || reservationNumber || "",
                                        })
                                      }
                                    >
                                      <div className="rounded-lg bg-white p-2 hover:shadow-lg hover:shadow-[#00E2E5]/20 transition-shadow">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                          src={qr}
                                          alt={`QR ${c.resNumber}`}
                                          width={140}
                                          height={140}
                                          className="w-[120px] h-[120px] sm:w-[160px] sm:h-[160px]"
                                        />
                                      </div>
                                      <p className="text-white/20 text-xs text-center mt-1">
                                        Tap to enlarge
                                      </p>
                                    </button>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[#00E2E5] font-bold text-2xl sm:text-3xl">
                                      {c.resNumber || reservationNumber}
                                    </p>
                                    {c.racerName && (
                                      <p className="text-white font-display text-lg uppercase tracking-wider mt-1">
                                        {c.racerName}
                                      </p>
                                    )}
                                    {heatStart && (
                                      <p className="text-white/50 text-sm mt-1">
                                        {formatDate(heatStart)}
                                      </p>
                                    )}
                                    {heatStart && (
                                      <div className="mt-3">
                                        <p className="text-red-400 text-xs font-bold uppercase tracking-wider">
                                          Check In By
                                        </p>
                                        <p className="text-white font-display text-3xl sm:text-4xl uppercase tracking-widest">
                                          {checkinTime(heatStart)}
                                        </p>
                                        <p className="text-white/30 text-xs">
                                          {checkInLocation === "fasttrax"
                                            ? "FastTrax — Guest Services, 2nd Floor"
                                            : "HeadPinz — Guest Services"}
                                        </p>
                                        <p className="text-white/20 text-xs">
                                          {checkInLocation === "fasttrax"
                                            ? "14501 Global Parkway, Fort Myers"
                                            : "14513 Global Parkway, Fort Myers"}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {/* Race list — names and times */}
                                {lines.length > 0 && (
                                  <div className="border-t border-white/[0.06] px-4 py-3 space-y-1.5">
                                    {lines.map(
                                      (
                                        line: {
                                          name: string;
                                          productId?: string | number;
                                          quantity: number;
                                          scheduledTime?: { start: string };
                                          schedules?: { start: string }[];
                                        },
                                        li: number,
                                      ) => {
                                        const lineTime =
                                          line.scheduledTime?.start || line.schedules?.[0]?.start;
                                        return (
                                          <div
                                            key={li}
                                            className="flex items-center justify-between"
                                          >
                                            <p className="text-white text-sm">
                                              {displayLineName(line)}
                                              {line.quantity > 1 ? ` x${line.quantity}` : ""}
                                            </p>
                                            {lineTime && (
                                              <p className="text-white/40 text-xs">
                                                {formatTime(lineTime)}
                                              </p>
                                            )}
                                          </div>
                                        );
                                      },
                                    )}
                                  </div>
                                )}

                                {/* Fallback if no stored lines */}
                                {lines.length === 0 && raceLine && ci === 0 && (
                                  <div className="border-t border-white/[0.06] px-4 py-3">
                                    <p className="text-white text-sm">
                                      {displayLineName(raceLine)}
                                      {raceLine.quantity > 1 ? ` x${raceLine.quantity}` : ""}
                                    </p>
                                  </div>
                                )}
                              </div>
                            );
                          });
                        })()}
                  </div>
                )}

                {/* Attraction detail — mirrors the original attraction
                    confirmation card (date/time, location, line item, waiver). */}
                {attractionsToShow.map((a, i) => {
                  const cfg = a.slug ? ATTRACTIONS[a.slug] : undefined;
                  const color = cfg?.color ?? "#00E2E5";
                  const name = cfg?.name ?? a.slug?.replace(/-/g, " ") ?? "Activity";
                  const qty = a.qty ?? 1;
                  const lineTotal = (a.price ?? 0) * qty;
                  return (
                    <div
                      key={`attr-${i}`}
                      className="mt-4 max-w-md mx-auto rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden"
                    >
                      <div className="p-5 space-y-4">
                        {/* Date & time */}
                        {(a.slot || a.date) && (
                          <div className="flex items-start gap-3">
                            <div
                              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                              style={{ backgroundColor: `${color}15` }}
                            >
                              <svg
                                className="w-5 h-5"
                                style={{ color }}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                viewBox="0 0 24 24"
                              >
                                <rect x="3" y="4" width="18" height="18" rx="2" />
                                <path d="M16 2v4M8 2v4M3 10h18" />
                              </svg>
                            </div>
                            <div>
                              <p className="text-white font-medium text-sm">
                                {a.slot ? formatDate(a.slot) : formatDate(`${a.date}T12:00:00`)}
                              </p>
                              {a.slot && (
                                <p className="text-white/50 text-xs">{formatTime(a.slot)}</p>
                              )}
                            </div>
                          </div>
                        )}
                        {/* Location */}
                        {cfg && (
                          <div className="flex items-start gap-3">
                            <div
                              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                              style={{ backgroundColor: `${color}15` }}
                            >
                              <svg
                                className="w-5 h-5"
                                style={{ color }}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                                />
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                                />
                              </svg>
                            </div>
                            <div>
                              <p className="text-white font-medium text-sm">{cfg.building}</p>
                              <p className="text-white/50 text-xs">{activityAddress(cfg)}</p>
                            </div>
                          </div>
                        )}
                        {/* Line item */}
                        <div className="pt-3 border-t border-white/[0.08] flex items-center justify-between">
                          <div>
                            <p className="text-white text-sm capitalize">{name}</p>
                            {qty > 1 && <p className="text-white/40 text-xs">Qty: {qty}</p>}
                          </div>
                          {lineTotal > 0 && (
                            <p className="font-bold text-sm" style={{ color }}>
                              ${lineTotal.toFixed(2)}
                            </p>
                          )}
                        </div>
                        {/* Waiver reminder */}
                        {cfg?.showWaiverPrompt && (
                          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
                            <svg
                              className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                              />
                            </svg>
                            <p className="text-amber-200/70 text-xs leading-relaxed">
                              All participants must complete a waiver before playing — online ahead
                              of time or at the check-in kiosk.
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Read-only bowling card — multi-activity bookings get NO
                self-service (no self check-in, cancel, or reschedule). Only
                bowling-ONLY bookings reach the interactive component at
                /hp/book/bowling/confirmation. */}
                {bowlingToShow.map((b, i) => {
                  const isKbf = b.kind === "kbf";
                  const cfg = ATTRACTIONS[isKbf ? "kids-bowl-free" : "bowling"];
                  const color = cfg?.color ?? "#fd5b56";
                  return (
                    <div
                      key={`bowl-${i}`}
                      className="mt-4 max-w-md mx-auto rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden"
                    >
                      <div className="p-5 space-y-4">
                        {/* Confirmation number */}
                        {b.qamfReservationId && (
                          <div
                            className="rounded-xl border px-4 py-3 flex items-center justify-between"
                            style={{ borderColor: `${color}40`, backgroundColor: `${color}10` }}
                          >
                            <span className="text-white/50 text-xs uppercase tracking-wider">
                              Confirmation #
                            </span>
                            <span className="font-mono font-bold text-lg" style={{ color }}>
                              {b.qamfReservationId}
                            </span>
                          </div>
                        )}
                        {/* Date & time */}
                        {(b.bookedAt || b.date) && (
                          <div className="flex items-start gap-3">
                            <div
                              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${color}15` }}
                            >
                              <svg
                                className="w-5 h-5"
                                style={{ color }}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                viewBox="0 0 24 24"
                              >
                                <rect x="3" y="4" width="18" height="18" rx="2" />
                                <path d="M16 2v4M8 2v4M3 10h18" />
                              </svg>
                            </div>
                            <div>
                              {b.date && (
                                <p className="text-white font-medium text-sm">
                                  {formatDate(`${b.date}T12:00:00`)}
                                </p>
                              )}
                              {b.bookedAt && (
                                <p className="text-white/50 text-xs">
                                  {new Date(b.bookedAt).toLocaleTimeString("en-US", {
                                    hour: "numeric",
                                    minute: "2-digit",
                                    hour12: true,
                                    timeZone: "America/New_York",
                                  })}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                        {/* Lanes & location */}
                        <div className="flex items-start gap-3">
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                            style={{ backgroundColor: `${color}15` }}
                          >
                            <svg
                              className="w-5 h-5"
                              style={{ color }}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                              />
                            </svg>
                          </div>
                          <div>
                            <p className="text-white font-medium text-sm">
                              {b.laneCount ?? 1} Lane{(b.laneCount ?? 1) > 1 ? "s" : ""}
                              {(b.playerCount ?? 0) > 0 ? ` · ${b.playerCount} Bowlers` : ""}
                            </p>
                            <p className="text-white/50 text-xs">
                              {cfg?.building ?? "HeadPinz"} — {activityAddress(cfg ?? null)}
                            </p>
                          </div>
                        </div>
                        {/* Front desk note */}
                        <div className="pt-3 border-t border-white/[0.08]">
                          <p className="text-white/40 text-xs">
                            Show this confirmation at the front desk when you arrive.
                          </p>
                        </div>
                        {/* Bowler names + shoe sizes + bumpers */}
                        {b.qamfReservationId && (
                          <BowlingPlayersEditor
                            qamfReservationId={b.qamfReservationId}
                            accent={color}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* POV Camera Codes
              The codes below are the actual unlock keys for the
              race video on ViewPoint — the racer (or their guardian
              for minors) enters them to redeem.

              Notification cadence is now identical for adult and
              junior: ViewPoint sends a "your video is ready" email
              + SMS heads-up about 5-10 min after the race. For
              minors the heads-up routes to the parent's contact
              via guardian fallback. Old "junior needs to come back
              and check manually" framing is obsolete now. */}
                {showRacing && povCodes.length > 0 && (
                  <div className="lg:col-span-2 mt-6 rounded-2xl border border-purple-500/20 bg-purple-500/5 p-6 sm:p-8">
                    <h3 className="font-display text-white text-xl uppercase tracking-widest mb-4">
                      Your ViewPoint POV Camera Codes
                    </h3>

                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 mb-3 flex items-start gap-3">
                      <span aria-hidden="true" className="text-xl leading-none">
                        📨
                      </span>
                      <div>
                        <p className="text-emerald-300 text-sm font-semibold mb-0.5">
                          Heads-up sent automatically
                        </p>
                        <p className="text-white/60 text-xs leading-relaxed">
                          About 5–10 minutes after your race, you&apos;ll get an{" "}
                          <strong className="text-white/80">email and text</strong> letting you know
                          your video is ready. Use the codes below to redeem it.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-4 mt-4">
                      {povCodes.map((code, i) => (
                        <div
                          key={i}
                          className="bg-white/10 border border-purple-500/30 rounded-lg px-5 py-3"
                        >
                          <p className="text-purple-300 text-xs font-semibold uppercase tracking-wider mb-1">
                            Code {i + 1}
                          </p>
                          <p className="text-white font-mono text-xl font-bold tracking-wider">
                            {code}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Additional Attractions for express lane bookings with mixed items.
                Dropped on multi-activity bookings — each attraction is its own
                hub button there, so this mixed-items card would be redundant. */}
                {showRacing &&
                  !isMulti &&
                  expressLane &&
                  (() => {
                    const allOvLines =
                      order?.lines ||
                      storedOverviews.flatMap((ov: { lines?: OrderLine[] }) => ov.lines || []);
                    const attractionLines = allOvLines.filter(
                      (l: OrderLine) =>
                        l.productGroup !== "Karting" &&
                        !l.name.toLowerCase().includes("license") &&
                        !l.name.toLowerCase().includes("pov"),
                    );
                    if (attractionLines.length === 0) return null;
                    return (
                      <div className="max-w-2xl mx-auto mt-6">
                        <div className="rounded-2xl border-2 border-red-500/40 bg-red-500/5 p-5 sm:p-6">
                          <h3 className="text-red-400 font-display text-lg uppercase tracking-widest mb-2">
                            Additional Attractions
                          </h3>
                          <p className="text-red-400/80 text-sm font-semibold mb-4">
                            Guest Services check-in is required for these attractions. Please arrive
                            30 minutes early.
                          </p>
                          <div className="space-y-3">
                            {attractionLines.map((line: OrderLine, i: number) => {
                              const sched =
                                line.scheduledTime ||
                                (line.schedules?.[0] ? { start: line.schedules[0].start } : null);
                              return (
                                <div
                                  key={i}
                                  className="flex items-center justify-between px-4 py-3 rounded-lg bg-white/5 border border-white/10"
                                >
                                  <div>
                                    <p className="text-white font-semibold text-sm">{line.name}</p>
                                    {line.quantity > 1 && (
                                      <span className="text-white/30 text-xs ml-1">
                                        x{line.quantity}
                                      </span>
                                    )}
                                  </div>
                                  {sched?.start && (
                                    <p className="text-white/60 text-sm font-mono">
                                      {formatTime(sched.start)}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <p className="text-white/30 text-xs mt-3">
                            {checkInLocation === "headpinz" ||
                            attractionLines.some(
                              (l: OrderLine) =>
                                l.name.toLowerCase().includes("gel") ||
                                l.name.toLowerCase().includes("laser"),
                            )
                              ? "HeadPinz — 14513 Global Parkway, Fort Myers"
                              : "FastTrax — Guest Services, 2nd Floor — 14501 Global Parkway, Fort Myers"}
                          </p>
                          {/* QR for attraction check-in */}
                          {qrDataUrl && (
                            <div className="mt-4 flex justify-center">
                              <button
                                className="cursor-pointer"
                                onClick={() =>
                                  setFullscreenQr({
                                    src: qrDataUrl,
                                    resNumber: reservationNumber || "",
                                  })
                                }
                              >
                                <div className="rounded-lg bg-white p-1.5 hover:shadow-lg transition-shadow">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={qrDataUrl}
                                    alt="QR"
                                    width={80}
                                    height={80}
                                    className="w-[70px] h-[70px]"
                                  />
                                </div>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                {/* Track Status for express lane */}
                {showRacing && expressLane && (
                  <div className="max-w-2xl mx-auto mt-6">
                    <ExpressTrackStatus liveStatus={liveStatus} />
                  </div>
                )}

                {/* Free Appetizer at Nemo's — per-package copy (Rookie Pack
              vs Ultimate Qualifier). The promo code is shown here
              on-page only; SMS + email hint "see your confirmation
              page for the appetizer code" so the code itself doesn't
              leak through forwarded messages. */}
                {showRacing && appetizerInfo && (
                  <div className="lg:col-span-2 mt-6 rounded-2xl border-2 border-amber-400/50 bg-amber-500/10 overflow-hidden">
                    <div className="p-5 sm:p-8 grid gap-6 lg:grid-cols-[minmax(0,1fr),minmax(0,360px)] lg:items-center">
                      {/* LEFT — messaging + appetizer choices */}
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span aria-hidden="true" className="text-2xl">
                            🍴
                          </span>
                          <p className="text-amber-300 text-xs font-bold uppercase tracking-widest">
                            {appetizerInfo.packageLabel} — Included
                          </p>
                        </div>
                        <h3 className="text-2xl font-display uppercase tracking-widest text-white mb-2">
                          Your Free Appetizer
                        </h3>
                        <p className="text-white/70 text-sm leading-relaxed mb-4">
                          Join us upstairs at <strong className="text-white">Nemo&apos;s</strong>{" "}
                          before or after your race. Show this code at the bar —{" "}
                          {appetizerInfo.note === "1 per group"
                            ? "one free appetizer per group"
                            : `free appetizer (${appetizerInfo.note})`}
                          .
                        </p>
                        <div className="space-y-1.5 text-xs text-white/60">
                          <p className="font-semibold text-white/80">Choose one:</p>
                          <ul className="ml-4 space-y-0.5 list-disc list-inside marker:text-amber-400/60">
                            {appetizerInfo.items.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                          <p className="text-white/40 pt-2">
                            {appetizerInfo.note === "1 per group"
                              ? "One per group"
                              : `${appetizerInfo.note[0].toUpperCase()}${appetizerInfo.note.slice(1)}`}{" "}
                            · Dine-in only · Race day only
                          </p>
                        </div>
                      </div>
                      {/* RIGHT — race-day pill + coupon code */}
                      <div className="space-y-3">
                        <div className="rounded-lg bg-amber-400/10 border border-amber-400/30 px-3 py-2">
                          <p className="text-amber-200 text-xs font-bold uppercase tracking-wider text-center">
                            ⏰ Valid Race Day Only
                          </p>
                        </div>
                        <div className="rounded-xl bg-black/30 border border-amber-400/40 px-4 py-5 text-center">
                          <p className="text-[10px] uppercase tracking-widest text-amber-300/70 mb-1">
                            Coupon Code
                          </p>
                          <p className="font-mono font-bold text-amber-300 text-3xl sm:text-4xl tracking-[0.2em]">
                            RACEAPP
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* RIGHT: Racer's Journey (racing only, not express lane, only in grid for multi-bill) */}
                {showRacing && !expressLane && confirmations.length > 1 && (
                  <div className="lg:sticky lg:top-40 lg:self-start">
                    <RacerJourneySteps liveStatus={liveStatus} />
                  </div>
                )}
              </div>

              {/* Journey below for single reservation (racing only, not express lane) */}
              {showRacing && !expressLane && confirmations.length <= 1 && (
                <div className="max-w-2xl mx-auto mb-8">
                  <RacerJourneySteps liveStatus={liveStatus} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Fullscreen QR modal */}
      {fullscreenQr && (
        <div
          className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center"
          {...modalBackdropProps(() => setFullscreenQr(null))}
        >
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fullscreenQr.src}
              alt="QR Code"
              className="w-[280px] h-[280px] sm:w-[350px] sm:h-[350px] mx-auto"
            />
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
    desc: 'Give yourself the "Pre-Race Window." Arriving early gives you time for any unexpected lines at check-in so you\'re cleared for the pits without losing a second of track time.',
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

function ExpressTrackStatus({ liveStatus }: { liveStatus: ReturnType<typeof useTrackStatus> }) {
  if (!liveStatus) return null;
  const { trackStatus: trackData, currentRaces } = liveStatus;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <p className="text-white/40 text-xs uppercase tracking-wider font-semibold mb-3">
        Live Track Status
      </p>
      <div className="space-y-2">
        {trackData.tracks?.map((t) => {
          const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as "blue" | "red" | "mega";
          const race = currentRaces[key] || null;
          return (
            <div
              key={t.trackName}
              className="px-4 py-2.5 rounded-lg"
              style={{
                backgroundColor: "rgba(1,10,32,0.6)",
                border: `1px solid ${t.colors.trackIdentity}50`,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: t.colors.trackIdentity }}>
                  {t.trackName}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${dotColor(t.status)}`} />
                  <span className="text-white/70 text-sm">{t.delayFormatted}</span>
                </div>
              </div>
              {race &&
                (() => {
                  let time = "";
                  try {
                    time = race.scheduledStart
                      ? new Date(race.scheduledStart).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: "America/New_York",
                        })
                      : "";
                  } catch {
                    /* skip */
                  }
                  return (
                    <p className="text-amber-400 text-xs font-bold mt-1">
                      Now Checking In: {race.raceType} #{race.heatNumber}
                      {time ? ` · ${time}` : ""}
                    </p>
                  );
                })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RacerJourneySteps({ liveStatus }: { liveStatus: ReturnType<typeof useTrackStatus> }) {
  const trackData = liveStatus?.trackStatus ?? null;
  const currentRaces = liveStatus?.currentRaces ?? null;

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
          <p className="text-white/30 text-xs uppercase tracking-wider font-semibold">
            Live Track Status
          </p>
          {trackData.tracks?.map((t) => {
            const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as
              | "blue"
              | "red"
              | "mega";
            const race = currentRaces?.[key] ?? null;
            return (
              <div
                key={t.trackName}
                className="px-3 py-2 rounded-lg"
                style={{
                  backgroundColor: "rgba(1,10,32,0.6)",
                  border: `1px solid ${t.colors.trackIdentity}50`,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold" style={{ color: t.colors.trackIdentity }}>
                    {t.trackName}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${dotColor(t.status)}`} />
                    <span className="text-white/70 text-xs">{t.delayFormatted}</span>
                  </div>
                </div>
                {race &&
                  (() => {
                    let time = "";
                    try {
                      time = race.scheduledStart
                        ? new Date(race.scheduledStart).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: "America/New_York",
                          })
                        : "";
                    } catch {
                      /* skip */
                    }
                    return (
                      <p className="text-amber-400 text-[11px] font-bold mt-1">
                        Now Checking In: {race.raceType} #{race.heatNumber}
                        {time ? ` · ${time}` : ""}
                      </p>
                    );
                  })()}
              </div>
            );
          })}
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
              <h3 className="font-display uppercase text-sm" style={{ color: s.color }}>
                {s.title}
              </h3>
              {s.subtitle && <p className="text-white/40 text-[13px]">{s.subtitle}</p>}
              <p className="text-white/70 text-xs leading-relaxed mt-1">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
