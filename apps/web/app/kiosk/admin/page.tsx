import { KioskAdmin } from "~/features/kiosk/components/KioskAdmin";

/**
 * Kiosk admin — staff device provisioning + comps. PIN-gated client
 * (KIOSK_ADMIN_PIN verified server-side on every API call). Not linked
 * anywhere guest-reachable; entered via the attract-screen corner gesture.
 */
export default function KioskAdminPage() {
  return <KioskAdmin />;
}
