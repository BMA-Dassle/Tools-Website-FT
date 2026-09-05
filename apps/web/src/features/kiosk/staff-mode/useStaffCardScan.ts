"use client";

/**
 * The staff-card SCAN GATE — hand it a raw scanner payload; it says whether it
 * claimed the scan.
 *
 * No port of its own. Serial opens are exclusive and the people steps already
 * own the scanner on every roster screen, so they pass their UNRECOGNISED
 * payloads here (useLicenseScan.onUnrecognised). A card-shaped payload on a
 * staff surface is claimed (`true`), resolved through /api/kiosk/staff-card,
 * and arms staff mode when it names a MANAGER (owner: any group containing
 * "Manager") — or leaves a notice saying why not. Anything else, or any scan outside a staff surface, is declined
 * (`false`) and the caller keeps its existing behavior.
 *
 * One resolution in flight at a time: a scanner that double-reads must not
 * fire two token mints.
 */
import { useCallback, useRef } from "react";
import { kioskStaffModeEnabled } from "../flags";
import { resolveStaffCardClient } from "./client";
import { staffCardAccountFromScan, cardTail } from "./staff-card";
import { useStaffSurface } from "./StaffModeSurface";
import { armStaffMode, setStaffNotice } from "./store";

export function useStaffCardScan(): (raw: string) => boolean {
  const surface = useStaffSurface();
  const inflight = useRef(false);
  return useCallback(
    (raw: string) => {
      if (!surface || !kioskStaffModeEnabled()) return false;
      const account = staffCardAccountFromScan(raw);
      if (!account) return false;
      if (inflight.current) return true;
      inflight.current = true;
      void resolveStaffCardClient({
        account,
        kioskId: surface.kioskId,
        location: surface.location,
      })
        .then((res) => {
          if (res.linked) {
            armStaffMode(res.employee, res.token);
            setStaffNotice(`Staff mode on — ${res.employee.name}`);
            return;
          }
          const tail = cardTail(account);
          if (res.reason === "not-manager") {
            setStaffNotice(`${res.name} is staff, but this menu needs a Manager role`, "warn");
          } else if (res.reason === "not-linked") {
            setStaffNotice(`Card ····${tail} isn't linked to a staff account`, "warn");
          } else if (res.reason === "unconfigured") {
            setStaffNotice("Staff cards aren't set up on this server yet", "warn");
          } else {
            setStaffNotice("Couldn't check that card — try again", "warn");
          }
        })
        .finally(() => {
          inflight.current = false;
        });
      return true;
    },
    [surface],
  );
}
