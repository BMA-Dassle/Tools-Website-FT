import { isProductPaused } from "~/features/maintenance";
import { KioskVendorOutage } from "~/features/kiosk/components/KioskVendorOutage";
import { KioskCheckinFlow } from "~/features/kiosk/checkin/KioskCheckinFlow";

/**
 * /kiosk/checkin — self-service check-in: find your reservation, see a
 * "what's next" itinerary, and (PR2+) finish the party's waivers + check in.
 * The attract-screen button is OPT-IN via NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED
 * (default OFF); this page stays reachable by typed URL either way for staff
 * testing.
 *
 * Vendor outage (maintenance mode): check-in needs BOTH BMI rails — Office to find
 * the reservation, and the booking API for registerProjectPerson, the racer
 * schedule write and the "Confirmation Kiosk" state stamp. Those writes are
 * Neon-first with a deliberately CONTAINED failure mode (never surfaced to the
 * guest), so with the booking rail dark this screen would happily say "you're
 * checked in" while BMI recorded nothing — the racer never reaches the grid and
 * staff never see the stamp.
 *
 * Gated SERVER-side here because this is the one enforcement point covering all
 * three ways in: the chooser's door (withdrawn separately in KioskFlow), a
 * scanned reservation QR that the entry-scan router sends straight here, and a
 * typed URL. A scan landing on this explanation beats a scan that does nothing.
 */
export default function KioskCheckinPage() {
  if (isProductPaused("checkin")) return <KioskVendorOutage />;
  return <KioskCheckinFlow />;
}
