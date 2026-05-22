"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RESERVATION_SECONDS = 10 * 60; // 10 minutes
const WARN_THRESHOLD = 2 * 60; // amber at 2 min
const URGENT_THRESHOLD = 60; // red at 1 min

interface ReservationTimerProps {
  bmiBillId: string | null;
  onExpired?: () => void;
}

export function ReservationTimer({ bmiBillId, onExpired }: ReservationTimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(RESERVATION_SECONDS);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef<string | null>(null);

  // Reset timer when bmiBillId first appears or changes
  useEffect(() => {
    if (!bmiBillId) {
      startedRef.current = null;
      setSecondsLeft(RESERVATION_SECONDS);
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    if (startedRef.current === bmiBillId) return;
    startedRef.current = bmiBillId;
    setSecondsLeft(RESERVATION_SECONDS);

    if (intervalRef.current) clearInterval(intervalRef.current);
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

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [bmiBillId, onExpired]);

  const refreshReservation = useCallback(async () => {
    if (!bmiBillId || refreshing) return;
    setRefreshing(true);
    try {
      // Hitting the bill overview keeps the BMI reservation alive
      await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${bmiBillId}`);
      setSecondsLeft(RESERVATION_SECONDS);
    } catch {
      /* non-fatal */
    } finally {
      setRefreshing(false);
    }
  }, [bmiBillId, refreshing]);

  if (!bmiBillId) return null;

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
          onClick={refreshReservation}
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
              onClick={refreshReservation}
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
}
