"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const RESERVATION_SECONDS = 10 * 60; // 10 minutes
export const QAMF_HOLD_SECONDS = 15 * 60; // 15 minutes for QAMF holds
export const WARN_THRESHOLD = 2 * 60; // amber at 2 min
export const URGENT_THRESHOLD = 60; // red at 1 min

const QAMF_EXTEND_INTERVAL = 8 * 60 * 1000; // auto-extend every 8 min
const BMI_EXTEND_CHECK = 60 * 1000; // re-check activity every 60s (BMI)

export interface ReservationHoldHandle {
  refresh: () => Promise<boolean>;
}

export interface UseReservationHoldOptions {
  bmiBillId: string | null;
  /** QAMF hold ID — when set, the hold is a QAMF lane hold instead of a BMI bill. */
  qamfHoldId?: string | null;
  /** QAMF center ID for the hold extend endpoint. */
  qamfCenterId?: number | null;
  onExpired?: () => void;
}

export interface ReservationHoldState {
  /** null → no live hold; callers render nothing. */
  holdKey: string | null;
  secondsLeft: number;
  maxSeconds: number;
  /** M:SS */
  display: string;
  isWarn: boolean;
  isUrgent: boolean;
  isExpired: boolean;
  refreshing: boolean;
  refresh: () => Promise<boolean>;
}

/**
 * Shared reservation-hold countdown: the soft "holding your spot" timer with
 * activity reset + vendor keep-alive. One hook, two renderers — the web
 * ReservationTimer pill and the kiosk KioskHoldBar strip.
 */
export function useReservationHold({
  bmiBillId,
  qamfHoldId,
  qamfCenterId,
  onExpired,
}: UseReservationHoldOptions): ReservationHoldState {
  const holdKey = bmiBillId || qamfHoldId || null;
  const isQamf = !bmiBillId && !!qamfHoldId;
  const maxSeconds = isQamf ? QAMF_HOLD_SECONDS : RESERVATION_SECONDS;

  const [secondsLeft, setSecondsLeft] = useState(maxSeconds);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const extendRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped on every click/keypress; the BMI auto-extend below only pings the
  // vendor when this changed since the last check, so an active session stays
  // held while an idle one still lapses.
  const activityRef = useRef(0);
  // Latest onExpired without being a countdown-effect dep — a new callback
  // identity must never restart (or kill) a running countdown.
  const onExpiredRef = useRef(onExpired);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  });

  function startCountdown(seconds: number) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSecondsLeft(seconds);
    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          onExpiredRef.current?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  // Countdown lifecycle — keyed ONLY on the hold identity. The vendor
  // keep-alive lives in its own effect below: with both in one effect, adding
  // a SECOND hold (race booked first, then a bowling lane → qamfHoldId joins
  // the deps) re-ran the cleanup, cleared both intervals, and the started-key
  // guard skipped the restart — a frozen display over a silently lapsing hold.
  useEffect(() => {
    if (!holdKey) {
      setSecondsLeft(maxSeconds);
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    startCountdown(maxSeconds);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [holdKey, maxSeconds]);

  // Vendor keep-alive — independent of the countdown so hold-composition
  // changes only ever swap the pinger, never the visible timer.
  useEffect(() => {
    // QAMF: auto-extend every 8 minutes to keep the hold alive
    if (isQamf && qamfHoldId) {
      extendRef.current = setInterval(() => {
        fetch(`/api/bowling/v2/reserve/hold/${encodeURIComponent(qamfHoldId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ centerId: qamfCenterId }),
        }).catch(() => {});
      }, QAMF_EXTEND_INTERVAL);
    } else if (bmiBillId) {
      // BMI: while the customer is ACTIVELY working (each click/keypress bumps
      // activityRef), keep the hold alive by touching the bill — the same
      // call the "Extend" button uses. If they go idle (no activity since the
      // last check) we stop pinging, so the hold still lapses.
      let lastSeen = activityRef.current;
      extendRef.current = setInterval(() => {
        if (activityRef.current === lastSeen) return;
        lastSeen = activityRef.current;
        fetch(`/api/sms?endpoint=bill%2Foverview&billId=${bmiBillId}`).catch(() => {});
      }, BMI_EXTEND_CHECK);
    }
    return () => {
      if (extendRef.current) clearInterval(extendRef.current);
    };
  }, [isQamf, qamfHoldId, qamfCenterId, bmiBillId]);

  // Renew on activity: any click/keypress resets the visible countdown and
  // marks the session active. The auto-extend above turns that into a real
  // vendor extend (QAMF unconditionally every 8 min; BMI only while active),
  // so the displayed time is honest and an idle session still expires.
  useEffect(() => {
    if (!holdKey) return;
    function onActivity() {
      activityRef.current += 1;
      setSecondsLeft(maxSeconds);
    }
    window.addEventListener("click", onActivity);
    window.addEventListener("keypress", onActivity);
    return () => {
      window.removeEventListener("click", onActivity);
      window.removeEventListener("keypress", onActivity);
    };
  }, [holdKey, maxSeconds]);

  const refreshReservation = useCallback(async (): Promise<boolean> => {
    if (!holdKey || refreshing) return false;
    setRefreshing(true);
    try {
      if (isQamf && qamfHoldId) {
        await fetch(`/api/bowling/v2/reserve/hold/${encodeURIComponent(qamfHoldId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ centerId: qamfCenterId }),
        });
      } else if (bmiBillId) {
        await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${bmiBillId}`);
      }
      startCountdown(maxSeconds);
      return true;
    } catch {
      return false;
    } finally {
      setRefreshing(false);
    }
  }, [holdKey, refreshing, isQamf, qamfHoldId, qamfCenterId, bmiBillId, maxSeconds]);

  const minutes = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const display = `${minutes}:${secs.toString().padStart(2, "0")}`;

  return {
    holdKey,
    secondsLeft,
    maxSeconds,
    display,
    isWarn: secondsLeft <= WARN_THRESHOLD,
    isUrgent: secondsLeft <= URGENT_THRESHOLD,
    isExpired: secondsLeft <= 0,
    refreshing,
    refresh: refreshReservation,
  };
}
