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
            <KioskVoucherBanner
              key={v.code}
              voucher={v}
              onClear={() => onClear(v)}
              variant="kiosk"
            />
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
  const label = single
    ? single.error
      ? t("voucher.pill.error")
      : single.pending
        ? t("voucher.pill.pending", { name: single.name ?? t("voucher.pill.fallbackName") })
        : t("voucher.pill.applied", { name: single.name ?? t("voucher.pill.fallbackName") })
    : hasError
      ? t("voucher.summary.attention", { count: vouchers.length })
      : t("voucher.summary.many", { count: vouchers.length });

  if (variant === "kiosk") {
    // The TWIN of the categories "Coupon or voucher?" chip — identical
    // geometry/type, only text + color differ (owner 2026-07-28). Details and
    // removal live in the sheet this opens.
    return (
      <button
        type="button"
        onClick={onOpen}
        className="k-tap flex h-[84px] items-center gap-[16px] rounded-full border-[1.5px] px-[36px] font-[family-name:var(--font-heading)] text-[26px] font-bold uppercase tracking-[0.08em]"
        style={{ borderColor: `${color}80`, color }}
      >
        <TicketGlyphSmall color={color} />
        {label}
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
