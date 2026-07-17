import type { NextRequest } from "next/server";

/**
 * Kiosk-admin gate. The kiosk admin screen is a STAFF surface on a physical
 * in-center device, reached via a hidden gesture on the attract screen → PIN.
 * The site's admin-auth uses an IP allowlist, which doesn't fit kiosk PCs on
 * varied venue LANs — so kiosk admin uses a dedicated PIN (KIOSK_ADMIN_PIN),
 * checked server-side on every admin API call and fail-closed when unset.
 */
export function kioskAdminOk(req: NextRequest): boolean {
  const expected = process.env.KIOSK_ADMIN_PIN || "";
  if (!expected) return false; // fail closed
  const pin =
    req.headers.get("x-kiosk-admin-pin") || new URL(req.url).searchParams.get("pin") || "";
  if (pin.length !== expected.length) return false;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= pin.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
