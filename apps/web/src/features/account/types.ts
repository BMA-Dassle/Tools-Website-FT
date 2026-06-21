/**
 * Shared types for the customer account feature (2FA login + Square
 * subscription payment management). v1 scope: view subscriptions, add a card,
 * change which saved card pays a subscription. See
 * tasks/.. plan "Centralized Customer Account".
 */

export type ContactType = "email" | "phone";
export type BrandKey = "fasttrax" | "headpinz";

/** What we persist in Redis under `acct:session:{sid}`. Never sent to the client. */
export interface SessionRecord {
  /** Verified contact, normalized (E.164 phone or lowercased email). */
  contact: string;
  contactType: ContactType;
  /**
   * Square customer ids bound to this session, derived SERVER-SIDE from the
   * verified contact at login. The client never supplies these. Every
   * subscription/card operation re-verifies its target belongs to one of these.
   */
  squareCustomerIds: string[];
  /** Double-submit CSRF token, echoed by /session/me, required on mutations. */
  csrf: string;
  /** ms epoch when the session was minted. */
  createdAt: number;
  /** ms epoch absolute expiry (createdAt + 12h) — forces periodic re-OTP. */
  exp: number;
}

export interface AccountSession extends SessionRecord {
  sid: string;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  expired: boolean;
  /** Owning Square customer id — set-card only offers cards from the sub's customer. */
  customerId: string;
}

export interface AccountSubscription {
  id: string;
  status: string;
  planName: string | null;
  locationId: string;
  locationLabel: string;
  brand: BrandKey;
  customerId: string;
  cardId: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Square optimistic-concurrency version — required to update the card. */
  version: number;
  nextBillingDate: string | null;
  /** Recurring amount in cents, when resolvable. */
  amount: number | null;
  /** Human cadence label (e.g. "Monthly"), when resolvable. */
  cadence: string | null;
}
