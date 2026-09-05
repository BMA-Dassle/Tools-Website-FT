"use client";

/**
 * The STAFF BAR — who armed the kiosk, how long the buttons have left, and
 * Staff logout. A staff surface slots it under its page header; it renders
 * nothing while staff mode is off.
 *
 * GREEN, deliberately: the kiosk's staff tier is green (KioskStaff.tsx — admin
 * is cyan), so staff chrome never reads as guest UI. The ring is the idle
 * clock; it reads "paused" (full, no number) while a sheet is open.
 */
import { IconLogout, IconUserShield } from "@tabler/icons-react";
import { STAFF_IDLE_MS, endStaffMode, useStaffCountdown, useStaffMode } from "./store";

export function StaffBar() {
  const { active, employee, sheet } = useStaffMode();
  const secondsLeft = useStaffCountdown();
  if (!active || !employee) return null;
  const paused = !!sheet || secondsLeft === null;
  const pct = paused ? 100 : Math.round(((secondsLeft ?? 0) * 1000 * 100) / STAFF_IDLE_MS);
  return (
    <div
      className="mx-[64px] mt-[8px] flex items-center gap-[20px] rounded-[22px] border-2 border-[#46d68c]/55 py-[18px] pl-[20px] pr-[24px]"
      style={{ background: "linear-gradient(90deg, rgba(70,214,140,0.18), rgba(70,214,140,0.06))" }}
      role="region"
      aria-label="Staff mode"
    >
      <span className="k-display flex shrink-0 items-center gap-[10px] rounded-[12px] bg-[#46d68c] px-[14px] py-[8px] text-[22px] tracking-[0.12em] text-[#04250f]">
        <IconUserShield size={26} aria-hidden="true" />
        Staff
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[30px] font-bold leading-[1.1] text-white">
          {employee.name}
        </div>
        <div className="mt-[2px] truncate text-[20px] text-white/55">
          {employee.role ? `${employee.role} · ` : ""}card ····{employee.cardTail}
          {paused
            ? " · paused while a sheet is open"
            : " · buttons hide after 10 s without a touch"}
        </div>
      </div>
      <div
        className="relative grid h-[84px] w-[84px] shrink-0 place-items-center rounded-full"
        style={{
          background: `conic-gradient(#46d68c ${pct}%, rgba(255,255,255,0.1) 0)`,
        }}
        aria-label={paused ? "Idle clock paused" : `${secondsLeft} seconds left`}
      >
        <span className="absolute inset-[7px] rounded-full bg-[#071027]" aria-hidden="true" />
        <span className="k-display k-num relative text-[34px] text-[#a6f0c8]">
          {paused ? "▮▮" : secondsLeft}
        </span>
      </div>
      <button
        type="button"
        onClick={() => endStaffMode()}
        className="k-tap flex h-[72px] shrink-0 items-center gap-[10px] rounded-full border-2 border-white/20 px-[24px] font-heading text-[22px] font-bold uppercase tracking-[0.06em] text-white/75"
      >
        <IconLogout size={26} aria-hidden="true" />
        Staff logout
      </button>
    </div>
  );
}
