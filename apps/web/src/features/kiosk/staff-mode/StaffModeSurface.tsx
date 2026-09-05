"use client";

/**
 * `StaffModeSurface` — wrap a kiosk page in this and it becomes a STAFF SURFACE:
 * a staff card scanned there arms staff mode, `StaffPersonActions` rows render
 * on its roster cards, and the staff sheets + notices have somewhere to mount.
 *
 * Pages that do NOT wrap themselves see none of it — `useStaffSurface()` is
 * null there, so the scan gate declines the scan and the action rows render
 * nothing, even if staff mode happens to be armed from another page. That is
 * what makes it safe to drop `StaffPersonActions` into shared roster code
 * (KioskPeopleStep / KioskPartyManager) without every consumer becoming a
 * staff surface by accident.
 *
 * `location` is the Pandora location KEY the actions write to — center first
 * ("naples" at Naples regardless of brand), like every other kiosk write.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskId as kioskIdOf } from "../config";
import { useStaffMode } from "./store";
import { StaffSheetHost } from "./StaffSheetHost";
import type { StaffLocation } from "./types";

export interface StaffSurfaceContextValue {
  location: StaffLocation;
  kioskId: string | null;
}

const StaffSurfaceContext = createContext<StaffSurfaceContextValue | null>(null);

/** Null outside a staff surface. */
export function useStaffSurface(): StaffSurfaceContextValue | null {
  return useContext(StaffSurfaceContext);
}

export function StaffModeSurface({
  location,
  children,
}: {
  location: StaffLocation;
  children: ReactNode;
}) {
  const { config } = useKioskConfig();
  const value: StaffSurfaceContextValue = {
    location,
    kioskId: config ? kioskIdOf(config) : null,
  };
  return (
    <StaffSurfaceContext.Provider value={value}>
      {children}
      <StaffSheetHost />
      <StaffNotice />
    </StaffSurfaceContext.Provider>
  );
}

/** The one-line notice ("Card ····3464 isn't linked to an employee", "Added
 *  License Fee for Maya"). Shows whether or not staff mode is on, so a card
 *  that fails to arm still gets an answer. Bottom-anchored, above the action
 *  bar, below any sheet. */
function StaffNotice() {
  const { notice } = useStaffMode();
  if (!notice) return null;
  const warn = notice.tone === "warn";
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-[240px] left-1/2 z-[74] -translate-x-1/2 rounded-[18px] border-2 px-[32px] py-[18px] text-[26px] font-bold shadow-2xl backdrop-blur-md"
      style={{
        background: warn ? "rgba(240,179,65,0.16)" : "rgba(70,214,140,0.16)",
        borderColor: warn ? "rgba(240,179,65,0.6)" : "rgba(70,214,140,0.6)",
        color: warn ? "#f5d38a" : "#a6f0c8",
      }}
    >
      {notice.text}
    </div>
  );
}
