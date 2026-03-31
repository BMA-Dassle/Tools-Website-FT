import { track } from "@vercel/analytics";

export function trackBookingClick() {
  track("Clicked Booking");
}

export function trackGroupRequestClick() {
  track("Clicked Group Request");
}
