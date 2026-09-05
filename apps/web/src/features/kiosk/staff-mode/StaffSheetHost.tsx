"use client";

/**
 * Renders whichever staff sheet the store says is open. Mounted once by
 * `StaffModeSurface`, so a sheet exists in exactly one place per page and the
 * roster rows never have to know how to draw one.
 *
 * Staff mode ending (idle expiry, logout) clears `sheet` in the store, so a
 * sheet can never outlive the credential it would submit with.
 */
import { useStaffMode } from "./store";
import { useStaffSurface } from "./StaffModeSurface";
import { AddMembershipSheet } from "./AddMembershipSheet";
import { AddCompSheet } from "./AddCompSheet";
import { RaceHistorySheet } from "./RaceHistorySheet";

export function StaffSheetHost() {
  const surface = useStaffSurface();
  const { active, sheet } = useStaffMode();
  if (!surface || !active || !sheet) return null;
  switch (sheet.kind) {
    case "membership":
      return (
        <AddMembershipSheet key={sheet.target.memberId} target={sheet.target} surface={surface} />
      );
    case "comp":
      return <AddCompSheet key={sheet.target.memberId} target={sheet.target} surface={surface} />;
    case "history":
      return (
        <RaceHistorySheet key={sheet.target.memberId} target={sheet.target} surface={surface} />
      );
  }
}
