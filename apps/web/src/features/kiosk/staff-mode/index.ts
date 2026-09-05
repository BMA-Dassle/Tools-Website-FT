/**
 * Kiosk staff mode — public (client-safe) surface. Server pieces
 * (`*.server.ts`, `data/`) are imported directly by route handlers, never from
 * here, so this barrel can be pulled into any client component.
 */
export { StaffModeSurface, useStaffSurface } from "./StaffModeSurface";
export { StaffBar } from "./StaffBar";
export { StaffPersonActions, STAFF_ACTIONS, targetFromMember } from "./StaffPersonActions";
export { useStaffCardScan } from "./useStaffCardScan";
export {
  STAFF_IDLE_MS,
  armStaffMode,
  closeStaffSheet,
  endStaffMode,
  openStaffSheet,
  setStaffNotice,
  touchStaffMode,
  useStaffCountdown,
  useStaffMode,
} from "./store";
export { staffCardAccountFromScan, cardTail } from "./staff-card";
export { usePersonLocal, staffActionEnabled, type LocalStatus } from "./local-status";
export type { StaffEmployee, StaffLocation, StaffTarget, StaffSheetKind } from "./types";
