/**
 * Build the `verificationDetails` object passed to Square Web Payments SDK
 * `card.tokenize(verificationDetails)`. This is the modern way to run Strong
 * Customer Authentication (3-D Secure): `verifyBuyer()` is DEPRECATED — do not
 * reintroduce it. Square applies SCA automatically when tokenize is given the
 * amount + buyer context (and our Risk Manager rules require it), which both
 * strengthens the challenge and the fraud liability-shift on the resulting
 * payment. Only the token (not a separate verification_token) goes to the
 * backend.
 *
 * Docs: Square "Web Payments SDK — Take a Card Payment" / "Add SCA".
 */

export type VerificationIntent = "CHARGE" | "STORE";

export interface BuyerContact {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface SquareVerificationDetails {
  /** Dollar string (e.g. "43.99"). Required for CHARGE; omitted for STORE. */
  amount?: string;
  currencyCode: "USD";
  intent: VerificationIntent;
  billingContact: {
    givenName?: string;
    familyName?: string;
    email?: string;
    phone?: string;
  };
  /** The buyer (not the seller) started this payment. */
  customerInitiated: true;
  /** Not a seller-keyed (MOTO) transaction — buyer entered their own card. */
  sellerKeyedIn: false;
}

/**
 * @param intent  "CHARGE" for a payment (pass amountDollars = the exact card
 *                amount being charged) or "STORE" for saving a card on file.
 */
export function buildVerificationDetails(opts: {
  intent: VerificationIntent;
  amountDollars?: number;
  contact?: BuyerContact;
}): SquareVerificationDetails {
  const billingContact: SquareVerificationDetails["billingContact"] = {};
  if (opts.contact?.firstName) billingContact.givenName = opts.contact.firstName;
  if (opts.contact?.lastName) billingContact.familyName = opts.contact.lastName;
  if (opts.contact?.email) billingContact.email = opts.contact.email;
  if (opts.contact?.phone) billingContact.phone = opts.contact.phone;

  const details: SquareVerificationDetails = {
    currencyCode: "USD",
    intent: opts.intent,
    billingContact,
    customerInitiated: true,
    sellerKeyedIn: false,
  };
  if (opts.intent === "CHARGE") {
    details.amount = Math.max(0, opts.amountDollars ?? 0).toFixed(2);
  }
  return details;
}
