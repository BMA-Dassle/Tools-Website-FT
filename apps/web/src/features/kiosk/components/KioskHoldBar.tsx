"use client";

/**
 * Kiosk hold countdown bar — the kiosk-scaled sibling of the web
 * ReservationTimer pill, rendered by KioskFlow's chrome() so it lives on
 * EVERY screen while a vendor hold is active (categories, wizard, cart,
 * checkout, VIP, game zone). Same soft-timer semantics as web via the shared
 * useReservationHold hook: resets on activity, QAMF auto-extends, BMI
 * activity-gated keep-alive.
 *
 * Styling: Tailwind only — NOT k-glass. The unlayered .kiosk-canvas .k-glass
 * rule sets background/border/border-radius/backdrop-filter and would
 * out-cascade the amber/red state utilities below.
 */
import { forwardRef, useImperativeHandle } from "react";
import {
  useReservationHold,
  type ReservationHoldHandle,
  type UseReservationHoldOptions,
} from "~/features/booking/hooks/useReservationHold";

export const KioskHoldBar = forwardRef<ReservationHoldHandle, UseReservationHoldOptions>(
  function KioskHoldBar(props, ref) {
    const hold = useReservationHold(props);

    useImperativeHandle(ref, () => ({ refresh: hold.refresh }), [hold.refresh]);

    if (!hold.holdKey) return null;

    const { display, isWarn, isUrgent, isExpired, refreshing, refresh } = hold;

    const stateClasses = isExpired
      ? "border-red-500/55 bg-red-500/15 text-red-300"
      : isUrgent
        ? "border-red-500/45 bg-red-500/10 text-red-300 animate-pulse"
        : isWarn
          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
          : "border-white/12 bg-[#071027]/60 text-white/70";

    return (
      <div
        className={`mx-[48px] mt-[20px] flex shrink-0 items-center justify-between gap-[20px] rounded-[20px] border px-[28px] py-[14px] backdrop-blur-[18px] ${stateClasses}`}
      >
        <span className="flex items-center gap-[14px] text-[22px] font-bold tracking-[0.18em] uppercase">
          <svg
            className="h-[28px] w-[28px] shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path strokeLinecap="round" d="M12 6v6l4 2" />
          </svg>
          Holding your spot
        </span>
        {isExpired ? (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="k-tap text-[26px] font-bold underline"
          >
            {refreshing ? "Refreshing…" : "Expired — tap to refresh"}
          </button>
        ) : (
          <span className="flex items-center gap-[20px]">
            <span className="k-num text-[34px] font-bold">{display}</span>
            {isWarn && (
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="k-tap h-[56px] rounded-full border border-current px-[28px] text-[22px] font-bold uppercase"
              >
                {refreshing ? "…" : "Extend"}
              </button>
            )}
          </span>
        )}
      </div>
    );
  },
);
