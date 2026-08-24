/**
 * Booking blocks — the companywide "do not sell" list.
 *
 * Born from the 2026-08-24 dispute batch: one party ("Mista Fee") charged back
 * four delivered visits across three cards in eight days, and a second party
 * charged back a bowling deposit AND the food delivered to that same lane. There
 * was no mechanism anywhere in the app to refuse them — verified: none of the 72
 * Neon tables was a block list. This is that mechanism.
 *
 * A block is matched on IDENTITY, never on a person's name: names are typed by
 * guests and are worthless as keys (the same party typed "Get F.", "Mista Fee"
 * and "Suprihano Nelson" across five bookings).
 */

/** What a block row matches on. */
export type BlockKind =
  | "email"
  /** Digits only, last 10 — see normalizePhone. */
  | "phone"
  | "square_customer"
  /** BMI/Office person id. Per-server: a person id is only meaningful with its
   *  center, so rows of this kind carry `center` too. */
  | "bmi_person"
  /** Square card fingerprint — stable across expiry/reissue, so it survives the
   *  card-cycling pattern that defeated email/phone matching. */
  | "card_fingerprint";

// BLOCK_KINDS (the runtime list) lives in ./normalize, beside the switch that
// must stay exhaustive with it. Keeping this module type-only also avoids the
// CJS-interop trap where a lone value export here is elided for .mts callers.

export interface BookingBlockRow {
  id: number;
  kind: BlockKind;
  /** Already normalized at write time — compare against normalizeValue(). */
  value: string;
  /** Required for `bmi_person`; null for identity kinds that are global. */
  center: string | null;
  /** Staff-facing why. Shown to managers, never to the guest. */
  reason: string;
  /** Square dispute ids / reservation refs so staff can look the case up. */
  caseRef: string | null;
  /** Who imposed it. "EO" for the 2026-08-24 batch. */
  submittedBy: string;
  active: boolean;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

/** The identity a booking attempt presents. Every field optional — different
 *  surfaces know different things (a walk-in kiosk booking has no Square
 *  customer; a return-racer lookup has a person id but no card yet). */
export interface BlockCandidate {
  email?: string | null;
  phone?: string | null;
  squareCustomerId?: string | null;
  bmiPersonId?: string | null;
  /**
   * Every racer on the booking, for the case a CLEAN contact books a BANNED
   * racer onto a heat. Without this, party A could keep booking party B's
   * visits. Ids are per-server, so `center` must be set alongside.
   */
  bmiPersonIds?: readonly string[] | null;
  /** Only known AFTER a charge, so it can gate a retry but never the first
   *  attempt. Recorded so the next attempt is caught even on a new email. */
  cardFingerprint?: string | null;
  /** Required to evaluate `bmi_person` rows (ids are per-server). */
  center?: string | null;
}

/** Result of a block check. `blocked: false` is the overwhelmingly common path
 *  and must stay allocation-cheap. */
export type BlockDecision =
  | { blocked: false }
  | {
      blocked: true;
      /** Every row that matched, so staff logs show WHY, not just THAT. */
      matches: BookingBlockRow[];
      /** Which kinds matched — for log lines and metrics, no PII. */
      kinds: BlockKind[];
    };
