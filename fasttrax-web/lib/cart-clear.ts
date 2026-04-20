/**
 * Cross-flow cart / hold cleaner.
 *
 * When a guest jumps from (e.g.) the attractions cart into the bowling
 * booking — which runs on a separate QAMF session, not the shared BMI
 * cart — we need to make sure their abandoned attractions cart doesn't
 * linger as a live BMI hold or stale sessionStorage that confuses the
 * next flow.
 *
 * This module centralizes what the various confirmation pages and the
 * MiniCart "Cancel & Start Over" button already do ad-hoc:
 *
 *   1. DELETE /api/bmi?endpoint=bill/{billId}/cancel if there's an
 *      active BMI order stashed in sessionStorage.
 *   2. Remove all cart-ish sessionStorage keys.
 *   3. Drop any `booking_{billId}` localStorage cache we recognize.
 *
 * The QAMF bowling hold that's created ONLY lives in the bowling page's
 * own React state — not in sessionStorage — so it naturally TTLs out on
 * QAMF's side (~15 min) once the user navigates away. We don't need to
 * cancel it from here.
 */

import { getBookingClientKey } from "./booking-location";

/** sessionStorage keys that hold cart/order state across the site. */
const CART_SESSION_KEYS = [
  "attractionCart",
  "attractionOrderId",
  "qamf_session_token",
] as const;

/** Return true if there's any active cart state worth warning the user about. */
export function hasActiveCart(): boolean {
  if (typeof window === "undefined") return false;
  for (const k of CART_SESSION_KEYS) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    // An empty "[]" cart is effectively not-a-cart.
    if (k === "attractionCart" && (v === "[]" || v.trim() === "")) continue;
    return true;
  }
  return false;
}

/**
 * Clear all known cart state — BMI hold + sessionStorage + localStorage.
 * Safe to call unconditionally; no-ops if there's nothing to clear.
 * Errors are swallowed so a bad BMI cancel doesn't block the next flow.
 */
export async function clearAllCarts(): Promise<void> {
  if (typeof window === "undefined") return;

  // 1. Cancel BMI hold if we have an order ID.
  const orderId = sessionStorage.getItem("attractionOrderId");
  if (orderId) {
    try {
      const ck = getBookingClientKey();
      const qs = ck
        ? `endpoint=bill/${orderId}/cancel&clientKey=${ck}`
        : `endpoint=bill/${orderId}/cancel`;
      await fetch(`/api/bmi?${qs}`, { method: "DELETE" });
    } catch {
      // BMI cancel failed — the hold will TTL out server-side anyway.
    }
  }

  // 2. Clear cart sessionStorage keys.
  for (const k of CART_SESSION_KEYS) {
    sessionStorage.removeItem(k);
  }

  // 3. Drop any booking_{billId} localStorage caches we can find.
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("booking_")) stale.push(key);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    // localStorage access blocked (privacy mode) — fine.
  }
}
