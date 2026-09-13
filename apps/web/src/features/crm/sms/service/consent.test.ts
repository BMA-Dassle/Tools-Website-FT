import { describe, expect, it } from "vitest";
import { consentBasisOnly, consentFor, isEnquirySource } from "./consent";
import type { LinkedLead } from "../types";

/**
 * The consent basis per lead source (brief R8). This is the matrix the whole
 * PR turns on: a cold row may be CALLED and EMAILED, never texted, until the
 * guest texts us first.
 */

function lead(over: Partial<LinkedLead> = {}): LinkedLead {
  return {
    id: "1",
    publicId: "L-1",
    source: "web",
    isProspect: false,
    assignedRepId: "7",
    centre: "HPFM",
    eventDate: "2026-10-17",
    eventType: "corporate",
    guests: 60,
    statusId: "assigned",
    ...over,
  };
}

const OK = { stopped: false, repDid: "+12392058142", smsEnabled: true, hasRep: true };

describe("consent basis", () => {
  it("web / phone / walk-in / referral are enquiry sources; cold and historical are not", () => {
    expect(["web", "phone", "walkin", "referral"].every(isEnquirySource)).toBe(true);
    expect(["cold", "historical"].some(isEnquirySource)).toBe(false);
  });

  it("a web lead may be texted — they gave us the number for this enquiry", () => {
    expect(consentFor({ ...OK, lead: lead(), hasInbound: false })).toEqual({
      allowed: true,
      basis: "enquiry",
      refusal: null,
    });
  });

  it("a COLD lead may not be texted: Call and Email only", () => {
    const v = consentFor({
      ...OK,
      lead: lead({ source: "cold", isProspect: true }),
      hasInbound: false,
    });
    expect(v.allowed).toBe(false);
    expect(v.refusal).toBe("no_consent");
  });

  it("a prospect from the mirror (historical) may not be texted either", () => {
    const v = consentFor({
      ...OK,
      lead: lead({ source: "historical", isProspect: true }),
      hasInbound: false,
    });
    expect(v.refusal).toBe("no_consent");
  });

  it("a prospect on an enquiry source is still a prospect — no consent", () => {
    const v = consentFor({
      ...OK,
      lead: lead({ source: "web", isProspect: true }),
      hasInbound: false,
    });
    expect(v.refusal).toBe("no_consent");
  });

  it("an inbound message from a COLD row unlocks texting — they texted us first", () => {
    const v = consentFor({
      ...OK,
      lead: lead({ source: "cold", isProspect: true }),
      hasInbound: true,
    });
    expect(v).toEqual({ allowed: true, basis: "inbound", refusal: null });
  });

  it("a number we do not know at all may not be texted until it texts us", () => {
    expect(consentFor({ ...OK, lead: null, hasInbound: false }).refusal).toBe("no_consent");
    expect(consentFor({ ...OK, lead: null, hasInbound: true }).basis).toBe("inbound");
  });

  it("STOP outranks every basis, inbound included", () => {
    const v = consentFor({ ...OK, stopped: true, lead: lead(), hasInbound: true });
    expect(v.refusal).toBe("stopped");
  });

  it("NO DID refuses before consent is even asked — and never falls back to the A2P number", () => {
    const v = consentFor({ ...OK, repDid: null, lead: lead(), hasInbound: true });
    expect(v.allowed).toBe(false);
    expect(v.refusal).toBe("no_did");
  });

  it("the kill switch answers first of all", () => {
    const v = consentFor({ ...OK, smsEnabled: false, lead: lead(), hasInbound: true });
    expect(v.refusal).toBe("sms_off");
  });

  it("a signed-in director with no rep row has nothing to text from", () => {
    expect(consentFor({ ...OK, hasRep: false, lead: lead(), hasInbound: true }).refusal).toBe(
      "no_rep",
    );
  });

  it("the list view asks about the PERSON only — the rep's own DID is not in question", () => {
    expect(consentBasisOnly({ lead: lead(), hasInbound: false }).basis).toBe("enquiry");
    expect(consentBasisOnly({ lead: lead({ source: "cold" }), hasInbound: false }).refusal).toBe(
      "no_consent",
    );
  });
});
