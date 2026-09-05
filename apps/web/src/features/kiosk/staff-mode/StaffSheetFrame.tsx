"use client";

/**
 * The shared shell every staff sheet sits in — the canvas-native full-screen
 * dim + k-glass panel the crew page's confirm sheet uses, in the staff GREEN.
 * No tap-outside dismiss (kiosk convention): Cancel is a button.
 *
 * z-[76]: above the notice (74) and the page, below IdleWatcher's countdown
 * (80) — the guest idle watchdog still wins over a staff sheet left open.
 */
import type { ReactNode } from "react";

export function StaffSheetFrame({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[76] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
      <div
        className="k-glass flex w-full max-w-[940px] flex-col gap-[22px] p-[44px]"
        style={{ borderColor: "rgba(70,214,140,0.35)" }}
        role="dialog"
        aria-modal="true"
        aria-label={`${eyebrow}: ${title}`}
      >
        <div>
          <div className="k-eyebrow text-[#46d68c]">{eyebrow}</div>
          <div className="k-display mt-[8px] text-[52px]">{title}</div>
          {subtitle && <div className="mt-[6px] text-[26px] text-white/60">{subtitle}</div>}
        </div>
        {children}
        <div className="mt-[6px] flex gap-[20px]">{footer}</div>
      </div>
    </div>
  );
}

/** Field label — small caps eyebrow in the muted tone. */
export function SheetLabel({ children }: { children: ReactNode }) {
  return (
    <div className="k-eyebrow mb-[10px] text-[20px] tracking-[0.18em] text-white/45">
      {children}
    </div>
  );
}

/** A chip in the sheet's chip rows. `disabled` = the catalogue has no id for it. */
export function SheetChip({
  selected,
  disabled,
  onClick,
  children,
  hint,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? "id not configured for this center" : undefined}
      onClick={onClick}
      aria-pressed={selected}
      className={`k-tap inline-flex h-[84px] items-center gap-[10px] rounded-[14px] border-2 px-[24px] font-heading text-[26px] font-bold disabled:opacity-35 ${
        selected
          ? "border-[#46d68c] bg-[#46d68c]/12 text-white shadow-[0_0_24px_rgba(70,214,140,0.18)]"
          : "border-white/10 bg-white/[0.03] text-white/60"
      }`}
    >
      {children}
      {hint && <span className="font-body text-[19px] font-medium text-white/40">{hint}</span>}
    </button>
  );
}

export function SheetCancel({
  onClick,
  label = "Cancel",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="k-tap flex h-[104px] flex-1 items-center justify-center rounded-full border-2 border-white/10 font-heading text-[30px] font-bold uppercase text-white/60"
    >
      {label}
    </button>
  );
}

export function SheetGo({
  onClick,
  disabled,
  busy,
  children,
  grow = 1.6,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
  grow?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      style={{ flex: grow }}
      className="k-display k-tap flex h-[104px] items-center justify-center rounded-full bg-[#46d68c] text-[34px] text-[#04250f] shadow-[0_12px_44px_rgba(70,214,140,0.3)] disabled:opacity-40 disabled:shadow-none"
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function SheetError({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[16px] border border-red-400/40 bg-red-400/10 px-[22px] py-[14px] text-[24px] text-red-200">
      {children}
    </p>
  );
}
