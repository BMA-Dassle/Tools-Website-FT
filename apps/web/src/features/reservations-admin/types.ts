/**
 * Shared types for the admin reservations board (portal-embedded).
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 *
 * BMI ids (bmiBillId, bmiReservationNumber, raceBillId) are TEXT — they exceed
 * Number.MAX_SAFE_INTEGER. Never coerce them with Number()/parseInt.
 */
import type { RaceLiveState } from "./race-live-state";

export interface ReservationLine {
  label: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Reservation {
  id: number;
  centerCode: string;
  productKind: string;
  qamfReservationId?: string;
  bmiBillId?: string;
  bmiReservationNumber?: string;
  squareDepositOrderId?: string;
  squareDayofOrderId?: string;
  squareGiftCardGan?: string;
  shortCode?: string;
  /** Canonical short confirmation link (/s/{code}) for this leg's BMI bill —
   *  attached server-side for combo race legs so the combo View opens the same
   *  short link the guest gets by email/SMS instead of a raw billId URL. */
  confirmationShortUrl?: string;
  depositCents: number;
  totalCents: number;
  status: string;
  bookedAt: string;
  playerCount?: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  cancelledAt?: string;
  refundCents: number;
  /** How the cancellation settled: 'refund' | 'store_credit' | 'none'. */
  cancellationOutcome?: string;
  /** Who cancelled: 'customer' (self-serve) or 'admin' (this portal). */
  cancelledBy?: string;
  /** HeadPinz FastTrax Gift Card issued on cancellation (Square-generated GAN). */
  storeCreditGiftCardGan?: string;
  storeCreditCents?: number;
  dayofOrderSentAt?: string;
  dayofOrderLane?: string;
  dayofPaymentId?: string;
  dayofOrderError?: string;
  dayofOrderSource?: string;
  preArrivalSentAt?: string;
  laneReadySentAt?: string;
  bookingSource?: string;
  squareLoyaltyRewardId?: string;
  rewardDiscountCents: number;
  /** Coupon / discount code applied at booking (e.g. "USA250"). */
  promoCode?: string;
  /** Pre-tax cents the coupon removed from this reservation's charge. */
  promoSavingsCents: number;
  checkinMethod?: string;
  loyaltyAction?: string;
  squareCustomerId?: string;
  /** Guest-survey snapshot — null when no survey has been sent for this reservation. */
  survey?: {
    token: string;
    status: "sent" | "opened" | "completed";
    rewardKind: "pinz" | "gift_card" | "declined" | null;
    rewardValue: number | null;
    sentAt: string;
    openedAt: string | null;
    completedAt: string | null;
    channel: "sms" | "email" | null;
  } | null;
  attractionBookings?: Array<{
    slug: string;
    name: string;
    quantity: number;
    totalPriceDollars: number;
    timeLabel: string;
  }>;
  /** Combo special id (e.g. 'race-bowl') when this row is one leg of a VIP combo. */
  comboSpecialId?: string;
  /** Real event time (naive ET ISO): race heat / attraction slot, else booked_at.
   *  The board displays + sorts on this, not booked_at. */
  eventAt?: string;
  /** Type-specific metadata. Race legs carry `heats` whose `heatId` is the
   *  heat's block-start ISO — the real per-heat schedule time. */
  bookingMetadata?: {
    heats?: Array<{
      productId?: number;
      track?: string;
      heatId?: string | null;
      assignedTo?: string;
    }>;
    [k: string]: unknown;
  };
  /** CURRENT scheduled race lines re-read from the BMI bill overview
   *  (server-side, race legs only). Office reschedules move heats after
   *  booking — and can convert an Intermediate to a second Starter — so when
   *  present these override the booking_metadata times stamped at booking.
   *  `start`/`stop` are naive ET wall-clock ISOs (same shape as heatId);
   *  stop is the REAL session end (~7-12 min sessions). `raceState` is live
   *  track truth (Pandora actualStart/actualEnd + called watermark, resolved
   *  server-side, same-day only) — beats the clock; absent = clock fallback. */
  liveHeats?: Array<{
    start: string;
    stop: string | null;
    name: string | null;
    sessionId?: string;
    heatNumber?: number;
    raceState?: RaceLiveState;
  }>;
  insertedAt: string;
  lines: ReservationLine[];
}

/** Display metadata for a combo special, keyed by combo id (from the server registry). */
export interface ComboMeta {
  name: string;
  accentColor: string;
  includes: string[];
  center: string;
  /** Lane length from the combo registry (Ultimate VIP = 90) — drives the
   *  board's live "time left on lane" countdown. */
  bowlingDurationMinutes?: number;
}

/** One step of a VIP combo's itinerary (race heat → bowling slot → race heat). */
export interface ComboScheduleStep {
  icon: string;
  label: string;
  iso: string | null;
  lane?: string;
  loc: string;
  pending?: boolean;
  /** Expected length of this step (minutes) — bowling from the combo
   *  registry; race legs use the REAL BMI session window (start→stop, ~7-12
   *  min) when live data is present, else the owner's assumed 30-min leg
   *  (mirrors ASSUMED_RACE_LEG_MINUTES in combo-booking). Drives the Done /
   *  in-progress / up-next markers on the card. */
  durationMin: number;
  /** The leg's reservation status, attached to the BOWLING step only —
   *  QAMF lane truth: `arrived` = lane open right now, `completed` = lane
   *  closed. Beats the clock when a party runs early or late. */
  legStatus?: string;
  /** Live track truth, attached to RACE steps only (from the leg's enriched
   *  liveHeats) — Pandora actualStart/actualEnd + called watermark. The
   *  race analog of legStatus: beats the clock; absent = clock fallback. */
  raceState?: RaceLiveState;
}

/** Attached to the single main-list row that represents a whole VIP combo
 *  (its two legs collapsed): the combined total and one entry per day-of order. */
export interface ComboMergeInfo {
  totalCents: number;
  orders: Array<{ orderId: string; kind: "Racing" | "Bowling"; leg: Reservation }>;
  legCount: number;
  /** Race leg's BMI bill — drives the multi-attraction (v2) confirmation view. */
  raceBillId?: string;
  /** Canonical short link (/s/{code}) for the race leg's v2 confirmation —
   *  preferred over a raw billId URL for the combo "View" link. */
  raceShortUrl?: string;
}

export interface GroupEvent {
  id: number;
  contractShortId: string;
  eventName: string;
  eventNumber: string;
  eventDate: string;
  eventDateDisplay: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  guestCount: number | null;
  plannerName: string | null;
  plannerEmail: string | null;
  plannerPhone: string | null;
  centerCode: string;
  brand: string;
  status: string;
  totalCents: number;
  depositDueCents: number;
  balanceCents: number;
  squareDepositOrderId: string | null;
  squareDayofOrderId: string | null;
  squareGiftCardGan: string | null;
  squareCustomerId: string | null;
  savedCardId: string | null;
  depositPaidAt: string | null;
  balancePaidAt: string | null;
  lineItems: Array<{ name: string; qty: number; total: number }>;
  notes: string | null;
  createdAt: string;
}

export interface SquareLineItem {
  uid: string;
  name: string;
  quantity: number;
  note: string | null;
  priceCents: number;
  grossCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  catalogId: string | null;
}

export type ShoeCategory = "Toddler" | "Male" | "Female";
