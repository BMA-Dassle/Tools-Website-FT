"use client";

/**
 * Voucher manager — the guest's vouchers as a screen, not a stack of banners
 * (owner 2026-07-27: "what if someone has 10 vouchers?"). The category strip
 * and cart show ONE summary pill; tapping it opens this: every voucher with
 * its state and a remove ✕, plus "Scan another" straight into the code-entry
 * screen. Scrolls past ~6 vouchers (kiosk-scroll).
 */

import type { AppliedVoucherState } from "~/features/booking/state/types";
import { KioskVoucherBanner } from "./KioskVoucherBanner";
import { voucherDisplayName } from "~/features/booking/service/voucher-redeem";
import { useT } from "../i18n";

export function KioskVoucherSheet({
  vouchers,
  onClear,
  onScanAnother,
  onBack,
}: {
  vouchers: AppliedVoucherState[];
  onClear: (voucher: AppliedVoucherState) => void;
  onScanAnother: () => void;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[96px]">
      <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
      <h1 className="k-display mt-[24px] text-[80px]">{t("voucher.sheet.title")}</h1>
      <p className="mt-[16px] text-[28px] text-white/60">{t("voucher.sheet.blurb")}</p>

      <div className="kiosk-scroll mt-[36px] min-h-0 flex-1">
        <div className="flex flex-col items-stretch gap-[20px] pb-[24px]">
          {vouchers.map((v) => (
            <div key={v.code} className="flex flex-col gap-[8px]">
              <KioskVoucherBanner voucher={v} onClear={() => onClear(v)} variant="kiosk" />
              {/* BMI's raw setup text — often carries the redemption note. */}
              {v.name && (
                <span className="px-[34px] text-[22px] leading-[1.3] text-white/45">{v.name}</span>
              )}
            </div>
          ))}
          {vouchers.length === 0 && (
            <div className="k-glass px-[40px] py-[64px] text-center text-[28px] text-white/55">
              {t("voucher.sheet.empty")}
            </div>
          )}
        </div>
      </div>

      <div className="mt-[20px] flex gap-[24px]">
        <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
          {t("codeEntry.back")}
        </button>
        <button type="button" onClick={onScanAnother} className="k-btn-primary k-tap">
          {t("voucher.sheet.scanAnother")}
        </button>
      </div>
    </div>
  );
}

/**
 * The compact strip/cart representation: ONE voucher renders its full banner
 * (with inline remove); two or more collapse to a count pill that opens the
 * sheet. An errored voucher tints the pill red so problems can't hide in the
 * count.
 */
export function KioskVoucherSummary({
  vouchers,
  onOpen,
  variant,
}: {
  vouchers: AppliedVoucherState[];
  onOpen: () => void;
  variant: "kiosk" | "web";
}) {
  const t = useT();
  if (vouchers.length === 0) return null;
  const hasError = vouchers.some((v) => v.error);
  const color = hasError ? "#ff8c7a" : "#46d68c";
  const single = vouchers.length === 1 ? vouchers[0] : null;
  // SHORT labels: the chip sits beside "Coupon or voucher?" on one row —
  // the long state sentences wrapped it onto its own line (owner 2026-07-28).
  // Full wording lives on the banners inside the sheet.
  const label = single
    ? single.error
      ? t("voucher.chip.error")
      : single.pending
        ? t("voucher.chip.pending", { name: voucherDisplayName(single.name) })
        : t("voucher.chip.applied", { name: voucherDisplayName(single.name) })
    : hasError
      ? t("voucher.summary.attention", { count: vouchers.length })
      : t("voucher.summary.many", { count: vouchers.length });

  if (variant === "kiosk") {
    // The TWIN of the categories "Coupon or voucher?" chip: identical
    // geometry/type, only text + color differ (owner 2026-07-28). Now a TILE,
    // not a pill — it shares the chooser's utility row with the code chip and
    // the language switcher, and that row only reads as a row when every box is
    // the same height, radius and border weight. flex-1 instead of a fixed
    // max-width so the row divides evenly however many boxes are in it. Still
    // truncating: a long comp name ("Complimentary 1 Hour Shuffly") must not
    // wrap this tile taller than its neighbours.
    return (
      <button
        type="button"
        onClick={onOpen}
        className="k-tap flex h-[96px] min-w-0 flex-1 items-center justify-center gap-[12px] rounded-[18px] border-[1.5px] bg-[rgba(7,16,39,0.5)] px-[14px] font-[family-name:var(--font-heading)] text-[24px] font-bold uppercase leading-tight tracking-[0.06em] backdrop-blur-[10px]"
        style={{ borderColor: `${color}80`, color }}
      >
        <TicketGlyphSmall color={color} />
        <span className="min-w-0 truncate">{label}</span>
        <span aria-hidden="true">›</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-3 flex w-full items-center justify-between rounded-lg border px-4 py-3"
      style={{ borderColor: `${color}66`, background: `${color}14` }}
    >
      <span className="text-sm font-semibold" style={{ color }}>
        {label}
      </span>
      <span className="text-lg leading-none" style={{ color }}>
        ›
      </span>
    </button>
  );
}

function TicketGlyphSmall({ color }: { color: string }) {
  return (
    <svg
      width="34"
      height="34"
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
