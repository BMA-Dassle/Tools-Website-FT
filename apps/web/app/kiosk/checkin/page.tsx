import { KioskCheckinFlow } from "~/features/kiosk/checkin/KioskCheckinFlow";

/**
 * /kiosk/checkin — self-service check-in: find your reservation, see a
 * "what's next" itinerary, and (PR2+) finish the party's waivers + check in.
 * The attract-screen button is OPT-IN via NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED
 * (default OFF); this page stays reachable by typed URL either way for staff
 * testing.
 */
export default function KioskCheckinPage() {
  return <KioskCheckinFlow />;
}
