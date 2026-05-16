import { track } from "@vercel/analytics";

export function trackBookingClick() {
  track("Clicked Booking");
}

export function trackGroupRequestClick() {
  track("Clicked Group Request");
}

// ── Generic step tracker ────────────────────────────────────────────────────

export function trackBookingStep(step: string, data?: Record<string, string | number>) {
  track(`Booking Step: ${step}`, data);
}

// ── Racing booking events ───────────────────────────────────────────────────

export function trackBookingExperience(type: "new" | "existing") {
  track("Book Racing: Experience Selected", { type });
}

export function trackBookingParty(adults: number, juniors: number) {
  track("Book Racing: Party Set", { adults, juniors, total: adults + juniors });
}

export function trackBookingDate(date: string) {
  track("Book Racing: Date Selected", { date });
}

export function trackBookingProduct(product: string, track_name: string | null, tier: string) {
  track("Book Racing: Race Selected", { product, track: track_name || "unknown", tier });
}

export function trackBookingHeat(time: string, track_name: string | null) {
  track("Book Racing: Heat Confirmed", { time, track: track_name || "unknown" });
}

export function trackBookingPov(quantity: number) {
  track("Book Racing: POV", { quantity, skipped: quantity === 0 ? "yes" : "no" });
}

export function trackBookingAddOns(addOns: string[]) {
  track("Book Racing: Add-Ons", { count: addOns.length, items: addOns.join(", ") || "none" });
}

export function trackBookingContact() {
  track("Book Racing: Contact Submitted");
}

export function trackBookingReview() {
  track("Book Racing: Review & Pay Viewed");
}

export function trackBookingPayment(method: "credit" | "square", amount: number) {
  track("Book Racing: Payment Started", { method, amount });
}

export function trackBookingComplete(reservationNumber: string) {
  track("Book Racing: Complete", { reservationNumber });
}

export function trackBookingAbandoned(lastStep: string) {
  track("Book Racing: Abandoned", { lastStep });
}

export function trackReturningRacer(found: boolean, accountCount: number) {
  track("Book Racing: Returning Racer Lookup", { found: found ? "yes" : "no", accountCount });
}

// ── Bowling booking events ──────────────────────────────────────────────────

export function trackBowlingStep(step: string, data?: Record<string, string | number | boolean>) {
  track(`Book Bowling: ${step}`, data);
}

// ── HeadPinz attractions booking events ─────────────────────────────────────

export function trackAttractionBooking(attraction: string, data?: Record<string, string | number>) {
  track(`Book Attraction: ${attraction}`, data);
}

// ── To-Go / Order Online events ─────────────────────────────────────────────

export function trackToGoOrder(action: string, data?: Record<string, string | number>) {
  track(`To-Go Order: ${action}`, data);
}
