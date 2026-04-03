import { track } from "@vercel/analytics";

export function trackBookingClick() {
  track("Clicked Booking");
}

export function trackGroupRequestClick() {
  track("Clicked Group Request");
}

// ── Booking flow events ─────────────────────────────────────────────────────

export function trackBookingStep(step: string, data?: Record<string, string | number>) {
  track(`Booking Step: ${step}`, data);
}

export function trackBookingExperience(type: "new" | "existing") {
  track("Booking: Experience Selected", { type });
}

export function trackBookingParty(adults: number, juniors: number) {
  track("Booking: Party Set", { adults, juniors, total: adults + juniors });
}

export function trackBookingDate(date: string) {
  track("Booking: Date Selected", { date });
}

export function trackBookingProduct(product: string, track_name: string | null, tier: string) {
  track("Booking: Race Selected", { product, track: track_name || "unknown", tier });
}

export function trackBookingHeat(time: string, track_name: string | null) {
  track("Booking: Heat Confirmed", { time, track: track_name || "unknown" });
}

export function trackBookingPov(quantity: number) {
  track("Booking: POV", { quantity, skipped: quantity === 0 ? "yes" : "no" });
}

export function trackBookingAddOns(addOns: string[]) {
  track("Booking: Add-Ons", { count: addOns.length, items: addOns.join(", ") || "none" });
}

export function trackBookingContact() {
  track("Booking: Contact Submitted");
}

export function trackBookingReview() {
  track("Booking: Review & Pay Viewed");
}

export function trackBookingPayment(method: "credit" | "square", amount: number) {
  track("Booking: Payment Started", { method, amount });
}

export function trackBookingComplete(reservationNumber: string) {
  track("Booking: Complete", { reservationNumber });
}

export function trackBookingAbandoned(lastStep: string) {
  track("Booking: Abandoned", { lastStep });
}

export function trackReturningRacer(found: boolean, accountCount: number) {
  track("Booking: Returning Racer Lookup", { found: found ? "yes" : "no", accountCount });
}
