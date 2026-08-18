/**
 * Groupon partner Offer API wire types (POS / redemption-only funnel).
 *
 * Shapes are read off live staging responses of 2026-08-18, NOT off the public
 * OpenAPI — that spec describes the Connect bookings contract and disagrees
 * with what this funnel actually returns.
 */

/** A voucher unit exactly as the GET returns it. Echoed back verbatim to redeem. */
export interface GrouponUnit {
  /** Groupon's unit uuid. */
  id: string;
  /** `available` before redemption, `redeemed` after. */
  status: string;
  /** Printed/emailed form: `VS-XXXX-XXXX-XXXX-XXXX`. Unambiguous to classify. */
  grouponCode: string;
  /** Short form the guest presents: 8 alphanumerics, e.g. `WNDXH4DJ`. */
  redemptionCode: string;
  /** ISO timestamp once redeemed, else null. */
  redeemedAt: string | null;
  value: { amount: number; currencyCode: string };
  price: { amount: number; currencyCode: string };
  /**
   * Null on every staging unit we have seen. If Groupon ever populates it for
   * real deals this is the most likely home for a deal identifier — which we
   * still need (see the deal-key gap in the plan).
   */
  attributes: Record<string, unknown> | null;
}

/**
 * Error codes observed live plus the documented set.
 *  - INVALID_REQUEST_SIGNATURE — signature wrong; client id was ACCEPTED.
 *  - UNIT_NOT_FOUND            — the identifier did not resolve.
 *  - INVALID_STATE_TRANSITION  — already redeemed. The double-redeem backstop.
 *  - MALFORMED_REQUEST         — body failed Groupon's own validation.
 *  - UNKNOWN_ERROR             — TRANSIENT. The only code worth retrying.
 */
export type GrouponErrorCode =
  | "INVALID_REQUEST_SIGNATURE"
  | "UNIT_NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "MALFORMED_REQUEST"
  | "UNKNOWN_ERROR"
  | (string & {});

/** Why a Groupon code cannot be redeemed here, in guest-answerable terms. */
export type GrouponRefusal =
  /** Groupon has never heard of it. */
  | "unknown"
  /** Spent — and we hold no local ledger row, so it was spent elsewhere. */
  | "already_redeemed"
  /** Groupon is unreachable or flaking; the guest should try again. */
  | "unavailable"
  /** We recognise the voucher but have no mapping for what it grants. */
  | "unmapped"
  /** Every item on it is already claimed with us. */
  | "used";
