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
  onClear,
  onOpen,
  variant,
}: {
  vouchers: AppliedVoucherState[];
  onClear: (voucher: AppliedVoucherState) => void;
  onOpen: () => void;
  variant: "kiosk" | "web";
}) {
  const t = useT();
  if (vouchers.length === 0) return null;
  if (vouchers.length === 1) {
    return (
      <KioskVoucherBanner
        voucher={vouchers[0]}
        onClear={() => onClear(vouchers[0])}
        variant={variant}
      />
    );
  }
  const hasError = vouchers.some((v) => v.error);
  const color = hasError ? "#ff8c7a" : "#46d68c";
  const label = hasError
    ? t("voucher.summary.attention", { count: vouchers.length })
    : t("voucher.summary.many", { count: vouchers.length });

  if (variant === "kiosk") {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="k-tap flex h-[84px] items-center gap-[18px] rounded-full border-[1.5px] px-[34px]"
        style={{ borderColor: `${color}a6`, background: `${color}1a` }}
      >
        <span className="k-display text-[26px]" style={{ color }}>
          {label}
        </span>
        <span className="k-display text-[30px]" style={{ color }}>
          ›
        </span>
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
