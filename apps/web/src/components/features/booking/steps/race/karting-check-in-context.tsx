"use client";

/**
 * KIOSK-ONLY karting-check-in treatment, shared down to the cards.
 *
 * Owner 2026-08-17: "do only kiosk for now because web would get confusing on
 * when they check in upstairs or karting. Label check in here as Karting Check
 * In."
 *
 * That is the right call and the reason is structural: at heat-pick time we do
 * not yet know whether the party will be Express Lane. A standard web guest must
 * be at GUEST SERVICES on the 2nd floor half an hour earlier, so stamping
 * "Karting Check In" on a web card would send them to the wrong floor. On a kiosk
 * the guest is already standing in the building, at the karting end of it, and
 * the karting desk is the only check-in the screen can mean.
 *
 * WHY A CONTEXT RATHER THAN A PROP THREADED DOWN: the estimate needs the live
 * on-time snapshot, and a hook per card would mount twenty pollers on a
 * twenty-heat grid. The kiosk variant calls `useTrackStatus` ONCE and publishes
 * it here; the web variant never mounts the provider, so the web booking flow
 * gains no polling at all and its cards read the inert default.
 *
 * WHY ITS OWN MODULE. It started inside RaceHeatPickerStep, which meant the
 * PACKAGE grid — Ultimate Qualifier, BOGO, every multi-race pack — could not
 * read it without importing its own parent. So the packs shipped without any of
 * this: same kiosk, same heats, but a bare time with no label and no estimate
 * (owner 2026-08-19: "on ultimate qualifier or bogo I do not [see it]"). The
 * provider still wraps the whole step, so the package grid was already INSIDE
 * it and only ever needed a way to look up.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";

export interface KartingCheckInCtx {
  enabled: boolean;
  onTime: OnTimeSnapshot | null;
}

const KartingCheckInContext = createContext<KartingCheckInCtx>({
  enabled: false,
  onTime: null,
});

/** Inert on web — the provider is only mounted by the kiosk variants, so a web
 *  grid reads `enabled: false` and renders exactly as it did before. */
export function useKartingCheckIn(): KartingCheckInCtx {
  return useContext(KartingCheckInContext);
}

/** Mounted by the kiosk variant only. One poll for the whole grid. */
export function KartingCheckInProvider({ children }: { children: ReactNode }) {
  const status = useTrackStatus();
  const value = useMemo<KartingCheckInCtx>(
    () => ({ enabled: true, onTime: status?.onTime ?? null }),
    [status?.onTime],
  );
  return <KartingCheckInContext.Provider value={value}>{children}</KartingCheckInContext.Provider>;
}
