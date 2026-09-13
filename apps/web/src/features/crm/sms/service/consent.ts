/**
 * MAY WE TEXT THIS PERSON? — the consent basis per lead source (brief R8).
 *
 * The rule the owner and the carrier both care about: we text someone because
 * they gave us THIS number for THIS enquiry, or because they texted us first.
 * A cold-list row did neither. So:
 *
 *   inbound      they have an inbound message on file → always fine to reply
 *   enquiry      a real (non-prospect) lead whose source is web / phone /
 *                walkin / referral — the guest handed us the number
 *   no_consent   everything else: `source: "cold"`, a `historical` row we dug
 *                out of the BMI mirror, or any `is_prospect` lead with no
 *                inbound message. The composer offers Call and Email only and
 *                `send.ts` refuses.
 *
 * PURE — no Neon, no env, no clock. The caller supplies the facts; this file
 * decides. That is what makes the matrix testable and why the same function
 * answers both the composer (what to draw) and the service (what to refuse):
 * a screen that offers a button the service will refuse is the bug this
 * prevents.
 *
 * Precedence is deliberate. A refusal a rep can DO something about comes
 * first: no DID is the director's job (owner item D5), STOP is the guest's
 * word and outranks any basis we might otherwise have had, and only then does
 * the source rule apply. `sms_off` (the kill switch) precedes all of it — when
 * texting is switched off, nothing else is worth saying.
 */

import type { LeadSource } from "../../core/types";
import type { ConsentVerdict, LinkedLead, SendRefusal } from "../types";

/** Sources where the guest gave us the number for this enquiry. */
export const ENQUIRY_SOURCES: readonly LeadSource[] = ["web", "phone", "walkin", "referral"];

/** Sources that are a prospect we went looking for, not an enquiry. */
export const PROSPECTING_SOURCES: readonly LeadSource[] = ["cold", "historical"];

export function isEnquirySource(source: string | null | undefined): boolean {
  return (ENQUIRY_SOURCES as readonly string[]).includes(source ?? "");
}

export interface ConsentFacts {
  /** The lead the conversation is about, or null when we do not know this number. */
  lead: LinkedLead | null;
  /** Does any thread with this number carry an inbound text? */
  hasInbound: boolean;
  /** Did they text STOP to this rep's number? */
  stopped: boolean;
  /** `crm_reps.vox_did` of the person composing; null = nothing to send from. */
  repDid: string | null;
  /** False when `CRM_SMS=false`. */
  smsEnabled: boolean;
  /** False when the signed-in person has no `crm_reps` row at all. */
  hasRep: boolean;
}

function refuse(refusal: SendRefusal): ConsentVerdict {
  return { allowed: false, basis: null, refusal };
}

export function consentFor(facts: ConsentFacts): ConsentVerdict {
  if (!facts.smsEnabled) return refuse("sms_off");
  if (!facts.hasRep) return refuse("no_rep");
  if (!facts.repDid) return refuse("no_did");
  if (facts.stopped) return refuse("stopped");
  if (facts.hasInbound) return { allowed: true, basis: "inbound", refusal: null };
  const lead = facts.lead;
  if (lead && !lead.isProspect && isEnquirySource(lead.source)) {
    return { allowed: true, basis: "enquiry", refusal: null };
  }
  return refuse("no_consent");
}

/**
 * The consent half ALONE — what the Conversations list shows next to a person
 * before a rep opens the thread, where the rep's own DID is not in question.
 */
export function consentBasisOnly(facts: Pick<ConsentFacts, "lead" | "hasInbound">): ConsentVerdict {
  return consentFor({
    ...facts,
    stopped: false,
    repDid: "pending",
    smsEnabled: true,
    hasRep: true,
  });
}
