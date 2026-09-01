import { isProductPaused } from "~/features/maintenance";
import { KioskVendorOutage } from "~/features/kiosk/components/KioskVendorOutage";
import { KioskCrewFlow } from "~/features/kiosk/crew/KioskCrewFlow";

/**
 * /kiosk/racers — the standalone "Your Crew" page: add / remove / sign in
 * everyone (accounts + waivers), no prices and no cart, on the PERSISTED kiosk
 * session — then hand the party into the booking flow. Also the landing pad
 * for a racing licence scanned on an entry screen with nothing booked today.
 * Doors (session banner tap, banner empty state, entry-scan racer arm) are
 * gated by kioskCrewEnabled(); this page itself stays reachable by typed URL
 * either way for staff testing.
 *
 * Vendor outage (maintenance mode): every add here mints a Pandora person and
 * signs a waiver, so with BMI dark there is nothing to sign against. Gated
 * SERVER-side because the page is reachable by typed URL and by scan — a guest
 * must never get far enough to draw a signature that lands nowhere.
 */
export default function KioskRacersPage() {
  if (isProductPaused("waiver")) return <KioskVendorOutage />;
  return <KioskCrewFlow />;
}
