"use client";

import { forwardRef, useImperativeHandle } from "react";
import {
  useReservationHold,
  type ReservationHoldHandle,
} from "~/features/booking/hooks/useReservationHold";

export type ReservationTimerHandle = ReservationHoldHandle;

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
    const hold = useReservationHold({ bmiBillId, qamfHoldId, qamfCenterId, onExpired });

    useImperativeHandle(ref, () => ({ refresh: hold.refresh }), [hold.refresh]);

    if (!hold.holdKey) return null;

    const { display, isWarn, isUrgent, isExpired, refreshing, refresh } = hold;

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
            onClick={() => void refresh()}
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
                onClick={() => void refresh()}
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
