import { isProductPaused } from "~/features/maintenance";
import { KioskVendorOutage } from "~/features/kiosk/components/KioskVendorOutage";
import { KioskWaiverFlow } from "~/features/kiosk/waiver/KioskWaiverFlow";

/**
 * /kiosk/waiver — the Online & Group Waiver flow: pick your reservation, see
 * who's already signed, add your group via the race-flow identity screens.
 * The attract-screen button is OPT-IN via
 * NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED (default OFF, owner 2026-07-19);
 * this page itself stays reachable by typed URL either way for staff testing.
 *
 * Vendor outage (maintenance mode): a waiver signs onto a Pandora person, so with
 * BMI dark there is nothing to sign against. Gated SERVER-side here rather than
 * only hiding the chooser's door — this page is reachable by typed URL, and a
 * guest must never get far enough to draw a signature that lands nowhere.
 */
export default function KioskWaiverPage() {
  if (isProductPaused("waiver")) return <KioskVendorOutage />;
  return <KioskWaiverFlow />;
}
