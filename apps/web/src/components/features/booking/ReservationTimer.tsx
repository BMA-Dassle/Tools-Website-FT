"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

const RESERVATION_SECONDS = 10 * 60; // 10 minutes
const QAMF_HOLD_SECONDS = 15 * 60; // 15 minutes for QAMF holds
const QAMF_EXTEND_INTERVAL = 8 * 60 * 1000; // auto-extend every 8 min
const WARN_THRESHOLD = 2 * 60; // amber at 2 min
const URGENT_THRESHOLD = 60; // red at 1 min

export interface ReservationTimerHandle {
  refresh: () => Promise<boolean>;
}

interface ReservationTimerProps {
  bmiBillId: string | null;
  /** QAMF hold ID — when set, timer manages a QAMF hold instead of a BMI bill. */
  qamfHoldId?: string | null;
  /** QAMF center ID for the hold extend endpoint. */
  qamfCenterId?: number | null;
  onExpired?: () => void;
}

export const ReservationTimer = forwardRef<ReservationTimerHandle, ReservationTimerProps>(
  function ReservationTimer({ bmiBillId, qamfHoldId, qamfCenterId, onExpired }, ref) {
    const holdKey = bmiBillId || qamfHoldId || null;
    const isQamf = !bmiBillId && !!qamfHoldId;
    const maxSeconds = isQamf ? QAMF_HOLD_SECONDS : RESERVATION_SECONDS;

    const [secondsLeft, setSecondsLeft] = useState(maxSeconds);
    const [refreshing, setRefreshing] = useState(false);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const extendRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startedRef = useRef<string | null>(null);

    function startCountdown(seconds: number) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setSecondsLeft(seconds);
      intervalRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            onExpired?.();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    // Reset timer when holdKey first appears or changes
    useEffect(() => {
      if (!holdKey) {
        startedRef.current = null;
        setSecondsLeft(maxSeconds);
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (extendRef.current) clearInterval(extendRef.current);
        return;
      }
      if (startedRef.current === holdKey) return;
      startedRef.current = holdKey;
      startCountdown(maxSeconds);

      // QAMF: auto-extend every 8 minutes to keep the hold alive
      if (isQamf && qamfHoldId) {
        if (extendRef.current) clearInterval(extendRef.current);
        extendRef.current = setInterval(() => {
          fetch(`/api/bowling/v2/reserve/hold/${encodeURIComponent(qamfHoldId)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ centerId: qamfCenterId }),
          }).catch(() => {});
        }, QAMF_EXTEND_INTERVAL);
      }

      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (extendRef.current) clearInterval(extendRef.current);
      };
    }, [holdKey, maxSeconds, isQamf, qamfHoldId, qamfCenterId, onExpired]);

    // Reset countdown on user activity (QAMF holds reset on interaction)
    useEffect(() => {
      if (!isQamf || !holdKey) return;
      function resetOnActivity() {
        setSecondsLeft(QAMF_HOLD_SECONDS);
      }
      window.addEventListener("click", resetOnActivity);
      window.addEventListener("keypress", resetOnActivity);
      return () => {
        window.removeEventListener("click", resetOnActivity);
        window.removeEventListener("keypress", resetOnActivity);
      };
    }, [isQamf, holdKey]);

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
    }, [holdKey, refreshing, isQamf, qamfHoldId, qamfCenterId, bmiBillId, maxSeconds, onExpired]);

    useImperativeHandle(ref, () => ({ refresh: refreshReservation }), [refreshReservation]);

    if (!holdKey) return null;

    const minutes = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    const display = `${minutes}:${secs.toString().padStart(2, "0")}`;

    const isUrgent = secondsLeft <= URGENT_THRESHOLD;
    const isWarn = secondsLeft <= WARN_THRESHOLD;
    const isExpired = secondsLeft <= 0;

    const colorClasses = isExpired
      ? "border-red-500/50 bg-red-500/15 text-red-400"
      : isUrgent
        ? "border-red-500/40 bg-red-500/10 text-red-400 animate-pulse"
        : isWarn
          ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
          : "border-white/15 bg-white/5 text-white/60";

    return (
      <div
        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-semibold ${colorClasses}`}
      >
        <svg
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path strokeLinecap="round" d="M12 6v6l4 2" />
        </svg>
        {isExpired ? (
          <button
            type="button"
            onClick={() => void refreshReservation()}
            disabled={refreshing}
            className="underline"
          >
            {refreshing ? "Refreshing…" : "Expired — tap to refresh"}
          </button>
        ) : (
          <>
            <span>{display}</span>
            {isWarn && (
              <button
                type="button"
                onClick={() => void refreshReservation()}
                disabled={refreshing}
                className="ml-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/20"
              >
                {refreshing ? "…" : "Extend"}
              </button>
            )}
          </>
        )}
      </div>
    );
  },
);
