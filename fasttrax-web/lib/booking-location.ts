/**
 * Booking location session management.
 * Stores the selected location in sessionStorage so all components
 * (nav, cart, checkout, API calls) can read it without URL params.
 */

import type { LocationKey } from "./attractions-data";

const KEY = "bookingLocation";

/** Set the active booking location */
export function setBookingLocation(location: LocationKey) {
  if (typeof window !== "undefined") {
    sessionStorage.setItem(KEY, location);
  }
}

/** Get the active booking location (null if not set) */
export function getBookingLocation(): LocationKey | null {
  if (typeof window === "undefined") return null;
  return (sessionStorage.getItem(KEY) as LocationKey) || null;
}

/** Clear the booking location (on cancel/complete) */
export function clearBookingLocation() {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(KEY);
  }
}

/** Resolve the BMI client key for the current booking location */
export function getBookingClientKey(): string | undefined {
  const loc = getBookingLocation();
  if (loc === "naples") return "headpinznaples";
  return undefined; // default = headpinzftmyers
}

/**
 * On page load, sync from ?location= URL param into sessionStorage.
 * Call this once in the booking page's initialization.
 */
export function syncLocationFromUrl() {
  if (typeof window === "undefined") return;
  const param = new URLSearchParams(window.location.search).get("location") as LocationKey | null;
  if (param) setBookingLocation(param);
}
