import { createHash } from "crypto";

/**
 * Compute a SHA-256 seal of the contract state at signing time.
 *
 * The seal is a hash of all material contract fields — if any field
 * changes after signing, recomputing the seal produces a different
 * hash, proving tampering.
 */

export interface SealInput {
  quoteId: number;
  reservationId: string;
  eventName: string;
  eventDate: string;
  centerName: string;
  lineItems: unknown[];
  totalCents: number;
  taxCents: number;
  depositDueCents: number;
  guestName: string;
  guestEmail: string;
  plannerName: string;
  plannerEmail: string;
  agreements: {
    deposit: boolean;
    autoCharge: boolean;
    taxExempt: "yes" | "no";
    waiverAcknowledged: boolean;
    tipsAcknowledged: boolean;
    policyAcknowledged: boolean;
  };
  signature: {
    type: "typed" | "drawn";
    value: string;
    timestamp: string;
  };
  signerIp: string;
  signerUserAgent: string;
  policyVersion: string;
}

export function computeDocumentSeal(input: SealInput): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export function verifySeal(input: SealInput, expectedHash: string): boolean {
  return computeDocumentSeal(input) === expectedHash;
}
