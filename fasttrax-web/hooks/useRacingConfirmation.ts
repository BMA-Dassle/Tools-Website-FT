"use client";

import { useEffect, useState, useRef } from "react";
import QRCode from "qrcode";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RacerConfirmation {
  billId: string;
  racerName: string;
  resNumber: string;
  resCode: string;
}

export interface RaceGroup {
  product: string;
  track: string | null;
  heatStart: string;
  heatName: string;
  racers: string[];
  resNumber: string;
  resCode: string;
  billId: string;
}

export interface UseRacingConfirmationInput {
  /** Primary BMI bill ID. */
  billId: string;
  /**
   * Skip BMI payment/confirm — set true when checkout/v2 already confirmed.
   * When false, the standalone page runs its own confirm flow.
   */
  skipBmiConfirm?: boolean;
  /**
   * Pre-resolved confirmation data (from checkout/v2 saveConfirmationData).
   * When provided, skips the booking-record fetch + BMI confirm flow.
   */
  preResolved?: {
    confirmations: RacerConfirmation[];
    raceGroups: RaceGroup[];
    expressLane: boolean;
    povCodes: string[];
    waiverUrl: string | null;
    rookiePack: boolean;
    checkInLocation: "fasttrax" | "headpinz";
  };
}

const BOOKING_API_KEY = "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Racing confirmation data hook — lighter version for the unified
 * confirmation page. When `preResolved` is provided, uses that data
 * directly (checkout/v2 already did all the heavy lifting). Otherwise
 * fetches the booking record + generates QR codes.
 *
 * The standalone racing confirmation page (/book/confirmation) has its
 * own 500-line useEffect that handles BMI confirm, notifications, POV
 * claiming, etc. This hook does NOT duplicate that. It handles the
 * post-checkout display case only.
 */
export function useRacingConfirmation(input: UseRacingConfirmationInput) {
  const { billId, preResolved } = input;

  const [loading, setLoading] = useState(!preResolved);
  const [confirmations, setConfirmations] = useState<RacerConfirmation[]>(preResolved?.confirmations ?? []);
  const [raceGroups, setRaceGroups] = useState<RaceGroup[]>(preResolved?.raceGroups ?? []);
  const [expressLane, setExpressLane] = useState(preResolved?.expressLane ?? false);
  const [povCodes, setPovCodes] = useState<string[]>(preResolved?.povCodes ?? []);
  const [waiverUrl, setWaiverUrl] = useState<string | null>(preResolved?.waiverUrl ?? null);
  const [rookiePack, setRookiePack] = useState(preResolved?.rookiePack ?? false);
  const [checkInLocation, setCheckInLocation] = useState<"fasttrax" | "headpinz">(preResolved?.checkInLocation ?? "fasttrax");
  const [racerQrCodes, setRacerQrCodes] = useState<Record<string, string>>({});
  const [primaryQrDataUrl, setPrimaryQrDataUrl] = useState<string | null>(null);
  const [fullscreenQr, setFullscreenQr] = useState<{ src: string; resNumber: string } | null>(null);

  const fetchStarted = useRef(false);

  // ── Generate QR codes when confirmations arrive ─────────────────────
  useEffect(() => {
    if (confirmations.length === 0) return;
    let cancelled = false;
    (async () => {
      const qrs: Record<string, string> = {};
      for (const c of confirmations) {
        try {
          qrs[c.billId] = await QRCode.toDataURL(c.resCode, {
            width: 160, margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
          });
        } catch { /* skip */ }
      }
      if (!cancelled) setRacerQrCodes(qrs);

      // Primary QR (larger, for the main display)
      const primaryCode = confirmations[0]?.resCode;
      if (primaryCode) {
        try {
          const url = await QRCode.toDataURL(primaryCode, {
            width: 200, margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
          });
          if (!cancelled) setPrimaryQrDataUrl(url);
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [confirmations]);

  // ── Fetch from booking record when no preResolved data ──────────────
  useEffect(() => {
    if (preResolved || fetchStarted.current || !billId) return;
    fetchStarted.current = true;
    let cancelled = false;

    (async () => {
      try {
        // Fetch booking record
        const recRes = await fetch(`/api/booking-record?billId=${billId}`, {
          headers: { "x-api-key": BOOKING_API_KEY },
        });
        if (!recRes.ok || cancelled) { setLoading(false); return; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bookingRecord: Record<string, any> = await recRes.json();

        // Build confirmations from booking record
        const resNum = bookingRecord.reservationNumber || "";
        const resCode = bookingRecord.reservationCode || `r${billId}`;
        const recordConfirmations = bookingRecord.confirmations as RacerConfirmation[] | undefined;
        if (recordConfirmations && recordConfirmations.length > 0) {
          if (!cancelled) setConfirmations(recordConfirmations);
        } else if (resNum) {
          if (!cancelled) setConfirmations([{ billId, racerName: bookingRecord.contact?.firstName || "", resNumber: resNum, resCode }]);
        }

        // Build race groups from racer assignments
        if (bookingRecord.racers && Array.isArray(bookingRecord.racers)) {
          const recRacers = bookingRecord.racers as { racerName?: string; product?: string; track?: string | null; heatStart?: string; heatName?: string }[];
          const groupMap = new Map<string, { product: string; track: string | null; heatStart: string; heatName: string; racers: string[] }>();
          for (const r of recRacers) {
            const key = `${r.product || "Race"}|${r.heatStart || ""}`;
            if (!groupMap.has(key)) {
              groupMap.set(key, {
                product: r.product || "Race",
                track: r.track || null,
                heatStart: r.heatStart || "",
                heatName: r.heatName || "",
                racers: [],
              });
            }
            groupMap.get(key)!.racers.push(r.racerName || "Racer");
          }
          const groups = [...groupMap.values()]
            .map(g => ({ ...g, resNumber: resNum, resCode, billId }))
            .sort((a, b) => a.heatStart.localeCompare(b.heatStart));
          if (!cancelled) setRaceGroups(groups);
        }

        // Express lane from booking record
        if (bookingRecord.fastLane === true) {
          if (!cancelled) setExpressLane(true);
        }

        // Rookie pack
        try {
          const { getPackageIgnoreFlag } = await import("@/lib/packages");
          const pkgId = bookingRecord.package as string | null | undefined;
          let appetizerCode: string | undefined;
          if (pkgId) appetizerCode = getPackageIgnoreFlag(pkgId)?.appetizerCode;
          else if (bookingRecord.rookiePack === true) appetizerCode = getPackageIgnoreFlag("rookie-pack")?.appetizerCode;
          if (appetizerCode && !cancelled) setRookiePack(true);
        } catch {
          if (bookingRecord.rookiePack === true && !cancelled) setRookiePack(true);
        }
      } catch { /* non-fatal */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [billId, preResolved]);

  return {
    loading,
    billId,
    confirmations,
    raceGroups,
    expressLane,
    povCodes,
    waiverUrl,
    rookiePack,
    checkInLocation,
    racerQrCodes,
    primaryQrDataUrl,
    fullscreenQr,
    setFullscreenQr,
  };
}

export type UseRacingConfirmationReturn = ReturnType<typeof useRacingConfirmation>;

// ── Helpers (shared with panels) ───────────────────────────────────────────

export function parseLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

export function formatTime(iso: string) {
  return parseLocal(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function checkinTime(iso: string) {
  const d = parseLocal(iso);
  d.setMinutes(d.getMinutes() - 30);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function formatDate(iso: string) {
  return parseLocal(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
