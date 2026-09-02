/**
 * Client-side kiosk PIN checks — a cheap authed GET against the matching
 * server gate (admin-auth.ts, fail-closed, 401 = wrong PIN). Extracted for
 * surfaces OUTSIDE /kiosk/admin that need a staff unlock (first user: the Race
 * Sims "Coming Soon" tile; second: /kiosk/staff).
 * Deliberately NOT a refactor of KioskAdmin — its adminFetch stays file-local.
 */

/** Provisioning tier — the admin PIN only. */
export async function verifyKioskAdminPin(pin: string): Promise<boolean> {
  try {
    const res = await fetch("/api/kiosk/admin?action=devices", {
      headers: { "x-kiosk-admin-pin": pin },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Floor tier — the staff PIN, or the admin PIN (which opens both). */
export async function verifyKioskStaffPin(pin: string): Promise<boolean> {
  try {
    const res = await fetch("/api/kiosk/staff?action=ping", {
      headers: { "x-kiosk-pin": pin },
    });
    return res.ok;
  } catch {
    return false;
  }
}
