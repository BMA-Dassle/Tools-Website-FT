/**
 * Reservation-edit engine — shared types.
 *
 * Spec: tasks/future/reservation-editing-plan.md (approved 2026-07-11).
 *
 * Vocabulary:
 *   - EditSpec is the desired END STATE (not a delta) so replays are
 *     idempotent and diffs are always server-computed.
 *   - EditPhase is derived from LIVE Square facts + the Neon row, never from
 *     Neon alone (guards.ts).
 *   - An EditPlan is the dry-run output: old→new lines, the authoritative
 *     price diff, the ordered steps execution will take, and warnings. Its
 *     planHash is required at execute time (displayed == executed).
 */

/** Money phase of the day-of order lifecycle. */
export type EditPhase = "pre" | "mid" | "post_complete";

/** How a price DECREASE settles (increases always charge). */
export type EditSettlement = "card_refund" | "store_credit";

/** Where the money for an INCREASE comes from. */
export type EditPaymentSource =
  | { kind: "card_on_file"; cardId: string }
  | { kind: "payment_link" }
  /** Square Web Payments nonce — the self-hosted payment-difference page. */
  | { kind: "nonce"; token: string }
  | { kind: "none" };

/** Desired player roster entry (bowling/KBF). */
export interface EditPlayerInput {
  /** 1-based slot within the reservation. */
  slot: number;
  name: string | null;
  shoeSize?: string | null;
  bumpers?: boolean | null;
}

/** Racer to add to a race/combo reservation. */
export interface EditRacerAdd {
  firstName: string;
  lastName?: string;
  category?: "adult" | "junior";
  /** New racer → license line applies (combo reallocation rules too). */
  isNew?: boolean;
  /** Known BMI person id for returning racers (raw string — never Number()). */
  bmiPersonId?: string | null;
}

/**
 * Desired end state. Every field optional — omitted means "unchanged".
 * Bowling/KBF fields are ignored for race rows and vice versa.
 */
export interface EditSpec {
  /** Bowling: total players. KBF: derived from the roster fields below. */
  playerCount?: number;
  /** Bowling per-lane experiences: explicit lane count. */
  laneCount?: number;
  /**
   * Hourly rentals: switch the lane-time length. Value is a
   * bowling_experience_duration_options.id for the booked experience; the
   * reprice swaps the primary line's multiplier (and override product when
   * the option defines one) and QAMF rebooks with the option's Time id.
   */
  durationOptionId?: number;
  /** Desired shoe quantities keyed by bowling_square_products.id. */
  shoes?: Record<number, number>;
  /** Full desired roster (names/shoes/bumpers). */
  players?: EditPlayerInput[];
  /** KBF roster money inputs (kids/family bowl free; adults pay per game). */
  kbf?: { kbfKidCount: number; fbfAdultCount: number; paidAdultCount: number };
  /** Race / combo racer changes. */
  racers?: {
    add?: EditRacerAdd[];
    /**
     * Heats to remove, identified by their index in booking_metadata.heats
     * (stable within one plan→execute round-trip because the planHash pins
     * the metadata snapshot).
     */
    removeHeatIndexes?: number[];
  };
  /**
   * Attraction add-on quantity changes (bowling rows), identified by index
   * into attraction_bookings. quantity 0 removes the add-on. PRE phase only —
   * BMI replaces the booked line (removeItem + re-book at the new quantity).
   */
  attractions?: Array<{ index: number; quantity: number }>;
  /**
   * Desired quantities for ARBITRARY day-of order lines, keyed by the LIVE
   * Square line-item `uid`. Quantity 0 removes the line outright.
   *
   * This is the input surface for refunding things the structured fields
   * cannot express — a returned pizza, a mis-rung soda, a shoe pair the guest
   * never took. Those lines are added to the order outside the booking engine
   * (food route, POS), so they have no reservation-level concept to edit; the
   * uid is the only stable handle.
   *
   * Engine-owned lines (the primary experience, shoes, race products) are
   * REJECTED here — they must move through their own typed fields so the
   * roster, QAMF, and BMI stay consistent with the money.
   */
  orderLines?: Record<string, number>;
}

export type EditGuardCode =
  | "not_found"
  | "cancelled"
  | "unsupported_kind"
  | "phase_conflict"
  | "combo_phase_split"
  // Non-combo multi-leg money group whose legs are in different phases.
  | "leg_phase_split"
  | "lane_change_mid_session"
  | "mid_session_unsupported"
  | "pricing_unresolvable"
  | "edit_in_progress"
  | "cancel_in_progress"
  | "plan_stale"
  | "post_complete_ack_required"
  | "bmi_line_unavailable"
  | "heat_capacity"
  | "qamf_availability"
  | "payment_required"
  // Day-of refund leg carries a staff-entered reason; "Reservation Deposit"
  // is reserved for the deposit/cash leg (portal journal key).
  | "dayof_reason_required"
  | "dayof_reason_reserved"
  // Whole-visit refund on a lane-open order — belongs to the cancel cascade.
  | "full_refund_use_cancel"
  | "no_changes";

/** Typed guard failure — routes map these to 409s with the code as reason. */
export class EditGuardError extends Error {
  readonly code: EditGuardCode;
  constructor(code: EditGuardCode, message?: string) {
    super(message ?? code);
    this.name = "EditGuardError";
    this.code = code;
  }
}

/** One planned/executed step. `fatal` steps abort the cascade on failure. */
export type EditStepKind =
  | "audit_start"
  | "qamf_rebook"
  | "qamf_set_players"
  | "qamf_memo"
  | "bmi_add_heats"
  | "bmi_remove_lines"
  | "bmi_attractions"
  | "charge_topup"
  | "await_payment_link"
  | "load_gift_card"
  | "refund_tender"
  | "adjust_gift_card_down"
  | "issue_store_credit"
  | "update_dayof_order"
  | "charge_dayof_order"
  | "refund_dayof_payment"
  | "refund_dayof_order"
  // Await the async gift-card credit from a day-of refund before any step
  // reads the card's balance (Square posts it seconds after the refund).
  | "wait_gc_credit"
  | "rebuild_dayof_order"
  | "pay_dayof_order"
  | "complete_dayof_order"
  | "neon_commit"
  | "notify";

export interface EditStep {
  kind: EditStepKind;
  fatal: boolean;
  /** Square/QAMF/BMI object id the step targets (order id, gift card id, …). */
  target?: string;
  detail?: string;
  amountCents?: number;
}

export interface EditWarning {
  severity: "info" | "warning" | "manager";
  code: string;
  message: string;
}

/** A priced line in the repriced (desired) state. */
export interface RepricedLine {
  /** bowling_square_products.id when the line maps to a Neon product. */
  squareProductId: number | null;
  squareCatalogObjectId: string | null;
  label: string;
  quantity: number;
  unitPriceCents: number;
  role: "primary" | "secondary" | "shoe" | "kbf_extra" | "race" | "license" | "passthrough";
  /**
   * True when the stored unit price was kept over a differing live catalog
   * price (promo/discounted bookings are never silently repriced to full).
   */
  priceHeld?: boolean;
}

/** A stored bowling_reservation_lines row joined with live product facts. */
export interface StoredLine {
  squareProductId: number | null;
  label: string;
  quantity: number;
  unitPriceCents: number;
  /** From bowling_square_products (null when the product row is gone). */
  productKind: "kbf" | "open" | "hourly" | "addon_shoe" | "addon_attraction" | "addon_food" | null;
  /** Live catalog price for drift detection (null when product row is gone). */
  catalogPriceCents: number | null;
  squareCatalogObjectId: string | null;
}

/** Facts about a shoe/add-on product available for NEW lines. */
export interface ProductFacts {
  squareProductId: number;
  label: string;
  priceCents: number;
  squareCatalogObjectId: string | null;
  productKind: StoredLine["productKind"];
}

/** booking_metadata.bowling stamp (written since PR 0). */
export interface BowlingBookedStamp {
  experienceSlug: string | null;
  laneCount: number;
  durationMultiplier: number;
  pricingMode: "per_lane" | "per_person";
}

/** One booking_metadata.heats entry (race rows). */
export interface HeatMeta {
  productId: string | null;
  track: string | null;
  heatId: string | null;
  assignedTo: string | null;
  tier?: string | null;
  category?: string | null;
  bmiPersonId: string | null;
  racer: string | null;
  /** BMI bill line id — present on rows booked since PR 0. */
  bmiLineId?: string | null;
}
