import { KioskStaff } from "~/features/kiosk/components/KioskStaff";

/**
 * Kiosk staff — the floor lead's tools: dispenser troubleshooting, live lane
 * grid, card-load audit. PIN-gated client (KIOSK_STAFF_PIN or the admin PIN,
 * verified server-side on every API call). Not linked anywhere guest-reachable;
 * entered via the attract-screen corner gesture (top-RIGHT — top-left is admin).
 */
export default function KioskStaffPage() {
  return <KioskStaff />;
}
