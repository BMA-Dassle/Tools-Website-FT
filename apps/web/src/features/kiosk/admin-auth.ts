import type { NextRequest } from "next/server";

/**
 * Kiosk staff gates. Both kiosk staff surfaces live on a physical in-center
 * device and are reached via a hidden gesture on the attract screen → PIN. The
 * site's admin-auth uses an IP allowlist, which doesn't fit kiosk PCs on varied
 * venue LANs — so the kiosk uses dedicated PINs, checked server-side on every
 * call and fail-closed when unset.
 *
 * TWO TIERS, because they are not the same job:
 *
 *   /kiosk/admin  (kioskAdminOk) — provisioning: device identity, Square reader
 *                 pairing, raw CRT-591 commands, Mifare read/write, comps.
 *   /kiosk/staff  (kioskStaffOk) — the floor tools: un-stick the dispenser,
 *                 read the lane grid, audit card loads.
 *
 * The admin PIN opens BOTH (a manager holding the higher credential must never
 * be locked out of the lesser surface). The staff PIN opens only /kiosk/staff.
 */

/** Constant-time-ish compare. Length is checked first, so it leaks only that. */
function pinMatches(supplied: string, expected: string): boolean {
  if (!expected) return false; // fail closed if ever blanked
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The PIN the caller supplied. `x-kiosk-pin` is the canonical header;
 * `x-kiosk-admin-pin` is kept because every existing admin client sends it.
 */
function suppliedPin(req: NextRequest): string {
  return (
    req.headers.get("x-kiosk-pin") ||
    req.headers.get("x-kiosk-admin-pin") ||
    new URL(req.url).searchParams.get("pin") ||
    ""
  );
}

/** The provisioning PIN. Owner-set interim 1185 (2026-07-18); override in Vercel. */
function adminPin(): string {
  return process.env.KIOSK_ADMIN_PIN || "1185";
}

/**
 * The floor PIN. Owner-set interim 14503 (2026-09-02), mirroring the admin
 * PIN's pattern; override KIOSK_STAFF_PIN in Vercel to rotate it without a
 * deploy. A non-empty fallback keeps the merged feature ON (owner rule
 * 2026-07-31) rather than shipping /kiosk/staff dark behind an env var.
 */
function staffPin(): string {
  return process.env.KIOSK_STAFF_PIN || "14503";
}

/** Gate for /kiosk/admin + /api/kiosk/admin. Admin PIN only. */
export function kioskAdminOk(req: NextRequest): boolean {
  return pinMatches(suppliedPin(req), adminPin());
}

/** Gate for /kiosk/staff + /api/kiosk/staff. Staff PIN or admin PIN. */
export function kioskStaffOk(req: NextRequest): boolean {
  const pin = suppliedPin(req);
  return pinMatches(pin, staffPin()) || pinMatches(pin, adminPin());
}
