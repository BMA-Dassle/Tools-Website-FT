/**
 * Card-vault types — the silent card-on-file subsystem behind reservation
 * editing (tasks/future/reservation-editing-plan.md §2/§7).
 *
 * Every booking quietly retains the guest's payment card so staff can charge
 * approved edit differences without calling the guest back. Cards WE added
 * (`weAdded`) and without explicit consent are auto-disabled ~72h after the
 * whole money group goes terminal (card-vault-sweep cron).
 */

/**
 * How the deposit was tendered, tagged by the client at tokenize time
 * (PaymentForm.tsx) and double-checked server-side. Only "card" payments are
 * storable via CreateCard; wallet tokens (Apple/Google Pay DPANs) are NOT.
 */
export type PaymentSourceKind = "card" | "wallet" | "saved" | "gift_card";

/** Where permanent-save consent came from. NULL on the row = silent capture
 *  (no consent — auto-disabled by the sweep). */
export type ConsentSource = "checkout_optin" | "admin" | "preexisting";

/** One row of `reservation_saved_cards` (camelCase mirror). */
export interface SavedCardRow {
  id: number;
  squareCustomerId: string;
  /** NULL while the capture is pending (CreateCard failed — sweep retries). */
  squareCardId: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  /** Square Card.fingerprint — dedupe key when populated (assumption A2). */
  fingerprint: string | null;
  sourceReservationId: number | null;
  /** Money-group key — one deposit order can fund multiple legs (combos). */
  sourceDepositOrderId: string | null;
  /** UNIQUE — the deposit payment the card was captured from. */
  sourcePaymentId: string;
  /** True when WE created the card on file (silent capture). False = the card
   *  pre-existed on the customer (dedupe hit / guest paid with a saved card) —
   *  never auto-disabled. */
  weAdded: boolean;
  /** True = never auto-disabled (checkout opt-in or admin grant). */
  permanentConsent: boolean;
  consentSource: ConsentSource | null;
  captureAttempts: number;
  captureLastError: string | null;
  disabledAt: string | null;
  disableAttempts: number;
  disableLastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Minimal reservation shape `isDueForDisable` needs per money-group leg. */
export interface DisableGroupLeg {
  status: string;
  /** ISO — visit time for bowling/KBF; BOOKING time for race/attraction
   *  anchors (their event times ride in bookingMetadata). */
  bookedAt: string;
  cancelledAt?: string | null;
  bookingMetadata?: Record<string, unknown> | null;
}

export interface CaptureCardParams {
  squareCustomerId: string | null | undefined;
  /** The deposit payment id (CreateCard source). */
  paymentId: string | null | undefined;
  reservationId: number | null;
  depositOrderId: string | null | undefined;
  /** Reserve idempotency base key (16 hex chars) — CreateCard key is
   *  `cof-${baseKey}` (20 chars, well under Square's 45-char cap). */
  baseKey: string;
  sourceKind: PaymentSourceKind | undefined;
  permanentConsent: boolean;
}

export type CaptureCardResult =
  | { ok: true; skipped: string }
  | { ok: true; cardId: string | null; deduped: boolean }
  | { ok: false; error: string };

export interface ChargeSavedCardParams {
  squareCustomerId: string;
  cardId: string;
  amountCents: number;
  locationId: string;
  orderId?: string;
  note?: string;
  /** Caller-derived (edit-engine `{editId}` namespace). Max 45 chars. */
  idempotencyKey: string;
}

export interface ChargeSavedCardResult {
  paymentId: string;
  status: string;
}

/** Resolved card for the edit dry-run / charge surface. */
export interface ChargeableCard {
  cardId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** True when the card came from a vault row (provenance known). */
  fromVault: boolean;
  permanentConsent: boolean;
}
