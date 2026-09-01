import type { AttractionItem } from "~/features/booking";

/**
 * The crew page's slug-less synthetic attraction item — carries the
 * participants toggle the people step expects; never priced, never booked,
 * and NEVER dispatched into `session.items` (it is passed to the people step
 * as a PROP only — see KioskCrewFlow's header). Same shape as the waiver
 * flow's newWaiverItem; own module so the contract is testable without
 * importing the component tree.
 */
export function newCrewItem(): AttractionItem {
  return {
    id: "crew",
    kind: "attraction",
    slug: null,
    date: null,
    slot: null,
    qty: 1,
    productId: null,
    pageId: null,
    price: 0,
    // Synthetic item — never booked, so the booking-side fields stay empty.
    bmiLineId: null,
    slotProposal: null,
    assignedTo: [],
  };
}
