/**
 * Client-side kiosk-admin PIN check — the same cheap authed GET KioskAdmin's
 * gate uses (`action=devices`; server gate is admin-auth.ts `kioskAdminOk`,
 * fail-closed, 401 = wrong PIN). Extracted for surfaces OUTSIDE /kiosk/admin
 * that need a staff unlock (first user: the Race Sims "Coming Soon" tile).
 * Deliberately NOT a refactor of KioskAdmin — its adminFetch stays file-local.
 */
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
