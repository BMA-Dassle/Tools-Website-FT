/**
 * combo-addon — post-booking "add more guests" to a completed combo special.
 *
 * Registry-driven: every package-specific decision (price, lane capacity,
 * heats-per-guest, revenue split) is read from the ComboSpecial, so a future
 * special that sets `addon.enabled` inherits this flow with no code change.
 *
 * The add-on is a SELF-CONTAINED second settlement: it books the new guests'
 * heats into a FRESH BMI bill (confirmed $0 credit, the zero model), seats them
 * on the bowling lane (adding a lane when capacity is exceeded), and creates its
 * OWN Square day-of order(s) + gift card — mirroring the original combo booking.
 * It never mutates the original orders. See tasks/lessons.md.
 */
import type { ComboEntity } from "~/features/combos";
import type { CenterCode } from "~/features/booking/types";

/** A guest being added. v1 treats every add as a NEW racer (no personId) at the
 *  flat per-person price (license folded in, like the original combo booking). */
export interface AddGuest {
  firstName: string;
  lastName?: string;
  /** Race category — drives which $0 build product books the heat. Default adult. */
  category?: "adult" | "junior";
}

/** One race leg the new guests must join — same heat the original party holds. */
export interface AddOnRaceLeg {
  tier: string;
  /** BMI productId of the leg's heat (from the original booking record). */
  productId: string;
  track: string | null;
  /** BMI wall-clock-in-Z heat start (the heatId the bill stores). */
  heatStart: string;
}

/** The bowling leg anchors needed to seat new guests / clone a new lane. */
export interface AddOnBowlingAnchor {
  qamfReservationId: string;
  qamfCenterId: number;
  /** ISO start of the booked lane (QAMF offset ISO). */
  bookedAt: string;
  webOfferId: number;
  optionId?: number;
  optionType: string;
  durationMinutes: number;
  /** Lanes already booked + players already seated (from the booking record). */
  laneCount: number;
  playerCount: number;
  /** Assigned lane number(s), display only. */
  lane: string | null;
}

/** Everything the engine needs, resolved from the original booking record. */
export interface AddOnContext {
  comboSpecialId: string;
  /** Original BMI bill — reference + notify only; the add-on books a NEW bill. */
  originalBillId: string | null;
  clientKey: string;
  center: CenterCode;
  /** YYYY-MM-DD of the event (drives weekday/weekend price + availability). */
  eventDate: string;
  raceLegs: AddOnRaceLeg[];
  bowling: AddOnBowlingAnchor | null;
  /** Guest contact (from the booking record) for receipts + QAMF/BMI registration. */
  contact: { firstName: string; lastName: string; email: string; phone: string };
}

/** Result of a capacity check for adding `addCount` guests. */
export interface AddOnCapacity {
  ok: boolean;
  addCount: number;
  /** Free spots in each race leg's heat, in itinerary order. */
  heatFreeByLeg: number[];
  currentPlayers: number;
  currentLanes: number;
  newLanes: number;
  /** Additional QAMF lanes the add would require (0 when it fits the existing lane). */
  lanesToAdd: number;
  /** Largest guest count that could still be added online right now. */
  maxAddable: number;
  /** Set when ok=false — a specific, customer-safe reason. */
  blockedReason?: string;
}

/** One entity's slice of the add-on charge → one Square day-of order. */
export interface AddOnOrderGroup {
  entity: ComboEntity;
  lines: Array<{ name: string; catalogObjectId: string; quantity: number; unitCents: number }>;
  subtotalCents: number;
}

/** Priced quote for adding `addCount` guests. */
export interface AddOnQuote {
  addCount: number;
  perPersonCents: number;
  totalCents: number;
  weekend: boolean;
  /** Per-entity day-of order groups (FastTrax racing + HeadPinz bowling). */
  orderGroups: AddOnOrderGroup[];
  /** Convenience totals by entity (cents). */
  fasttraxCents: number;
  headpinzCents: number;
}

/** Outcome of a completed add-on purchase. */
export interface AddOnResult {
  ok: boolean;
  addedGuestCount: number;
  newBmiBillId: string | null;
  bmiReservationNumber: string | null;
  qamfReservationIds: string[];
  squareDayofOrderIds: string[];
  giftCardGan: string | null;
  chargedCents: number;
  lanesAdded: number;
}
