"use client";

/**
 * The session's voucher, visible and removable everywhere it matters (owner
 * 2026-07-27: "no feedback on if the voucher is added to transaction, no way
 * to see or remove") — rendered on the category chooser strip (kiosk-canvas
 * scale) and above the cart list (web scale, inside .kiosk-zoom).
 *
 * Three states, colored by consequence:
 *   applied  (green)  — comp line is ON the BMI bill; ✕ removes it for real.
 *   pending  (cyan)   — scanned before anything was booked; applies itself
 *                       the moment the booking creates a bill. ✕ just clears.
 *   error    (red)    — apply failed; the guest pays full price unless they
 *                       clear it or Guest Services steps in.
 */

import type { AppliedVoucherState } from "~/features/booking/state/types";
import { voucherDisplayName } from "~/features/booking/service/voucher-redeem";
import { useT } from "../i18n";

export function KioskVoucherBanner({
  voucher,
  onClear,
  variant,
}: {
  voucher: AppliedVoucherState;
  onClear: () => void;
  /** "kiosk" = 1080-canvas px (categories strip) · "web" = rem scale (cart). */
  variant: "kiosk" | "web";
}) {
  const t = useT();
  const name = voucher.name ? voucherDisplayName(voucher.name) : t("voucher.pill.fallbackName");
  const state = voucher.error ? "error" : voucher.pending ? "pending" : "applied";
  const text =
    state === "error"
      ? t("voucher.pill.error")
      : state === "pending"
        ? t("voucher.pill.pending", { name })
        : t("voucher.pill.applied", { name });
  const color = state === "error" ? "#ff8c7a" : state === "pending" ? "#00e2e5" : "#46d68c";
  const codeTail = `…${voucher.code.slice(-4)}`;

  if (variant === "kiosk") {
    return (
      <div
        className="flex h-[84px] items-center gap-[18px] rounded-full border-[1.5px] px-[34px]"
        style={{ borderColor: `${color}a6`, background: `${color}1a` }}
      >
        <TicketGlyph color={color} size={34} />
        <span className="k-display text-[26px]" style={{ color }}>
          {text}
        </span>
        <span className="k-num text-[22px] text-white/45">{codeTail}</span>
        <button
          type="button"
          onClick={onClear}
          aria-label={t("voucher.pill.remove")}
          className="k-tap ml-[6px] px-[8px] text-[30px] leading-none text-white/45"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      className="mb-3 flex items-center gap-3 rounded-lg border px-4 py-3"
      style={{ borderColor: `${color}66`, background: `${color}14` }}
    >
      <TicketGlyph color={color} size={20} />
      <span className="text-sm font-semibold" style={{ color }}>
        {text}
      </span>
      <span className="font-mono text-xs text-white/40">{codeTail}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t("voucher.pill.remove")}
        className="ml-auto px-1 text-lg leading-none text-white/40 hover:text-white"
      >
        ✕
      </button>
    </div>
  );
}

function TicketGlyph({ color, size }: { color: string; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M15 5v2" />
      <path d="M15 11v2" />
      <path d="M15 17v2" />
      <path d="M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2" />
    </svg>
  );
}
