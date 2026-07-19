import { KioskWaiverFlow } from "~/features/kiosk/waiver/KioskWaiverFlow";

/**
 * /kiosk/waiver — the Online & Group Waiver flow: pick your reservation, see
 * who's already signed, add your group via the race-flow identity screens.
 * Reachable by typed URL for the staff smoke even while the attract-screen
 * button is flag-gated off (NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED).
 */
export default function KioskWaiverPage() {
  return <KioskWaiverFlow />;
}
