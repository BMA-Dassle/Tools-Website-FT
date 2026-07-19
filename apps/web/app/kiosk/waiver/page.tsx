import { KioskWaiverFlow } from "~/features/kiosk/waiver/KioskWaiverFlow";

/**
 * /kiosk/waiver — the Online & Group Waiver flow: pick your reservation, see
 * who's already signed, add your group via the race-flow identity screens.
 * The attract-screen button is OPT-IN via
 * NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED (default OFF, owner 2026-07-19);
 * this page itself stays reachable by typed URL either way for staff testing.
 */
export default function KioskWaiverPage() {
  return <KioskWaiverFlow />;
}
