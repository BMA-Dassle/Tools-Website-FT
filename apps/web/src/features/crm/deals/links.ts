/**
 * Every page a planner might need to open FOR a guest, in one place.
 *
 * Owner, 2026-09-13, on Juniper Landscaping: "We should have links to customer
 * confirmation page, waiver page for customer, latest contract, contract
 * history, etc. etc." Each of these already exists and is already linked from
 * an email somewhere; what was missing is anywhere in the CRM that gathers
 * them, so a planner asked "can you resend me the waiver link?" had to go and
 * reconstruct one.
 *
 * PURE, and no `process.env` — this runs in the browser. The brand host comes
 * from the QUOTE (`group_function_quotes.base_url`, carried on
 * `LeadContractSummary`), because a FastTrax event issued on fasttraxent.com
 * must not be handed to a guest as a headpinz.com link and vice versa; a link
 * that crosses brands reads as a phishing attempt to the person clicking it.
 * With no quote there is no contract host, so the centre's own brand is the
 * fallback and only the waiver — which is not contract-scoped — is offered.
 *
 * `/contract/{shortId}` is deliberately BOTH "the contract" and "the
 * confirmation page": `ContractClient` renders sign, pay and done from the one
 * route, so after signing that URL is what the guest sees as their
 * confirmation. `/signed` exists only as a stable PandaDoc redirect target and
 * bounces back here, so it is not offered as a separate link.
 */

import type { CentreCode } from "../core/types";
import type { LeadContractSummary } from "../leads/contracts";

/** FastTrax events are issued on fasttraxent.com; HeadPinz on headpinz.com. */
export const BRAND_HOST: Record<CentreCode, string> = {
  FT: "https://fasttraxent.com",
  HPFM: "https://headpinz.com",
  HPN: "https://headpinz.com",
};

export type DealLinkId = "contract" | "pdf" | "pay" | "waiver" | "history";

export interface DealLink {
  id: DealLinkId;
  label: string;
  href: string;
  /** `guest` opens something a guest is meant to see; `staff` stays in the CRM. */
  audience: "guest" | "staff";
  /** One line of help, because "Pay balance" and "Contract" are not self-evident. */
  hint: string;
}

export interface DealLinkInput {
  publicId: string;
  centre: CentreCode;
  contract: LeadContractSummary | null;
  /** The BMI project the waiver's signatures attach to. */
  bmiProjectId: string | null;
  /** `Centre.locationId` — the waiver link needs both halves or it attaches to nothing. */
  locationId: number | string | null;
}

function host(input: DealLinkInput): string {
  const fromQuote = input.contract?.baseUrl?.trim();
  return (fromQuote || BRAND_HOST[input.centre]).replace(/\/+$/, "");
}

/**
 * The reservation-scoped waiver. Both `loc` and `pid` or neither — a link with
 * one half silently degrades to a standalone waiver whose signatures attach to
 * nothing, while still LOOKING reservation-scoped to the guest. This mirrors
 * `~/features/waiver/build-waiver-url`, which is the canonical builder; it is
 * not imported because that module reads `process.env` for its absolute form
 * and this one runs in the browser.
 */
export function waiverHref(input: DealLinkInput): string {
  const params = new URLSearchParams({ c: input.centre === "FT" ? "fasttrax" : "headpinz" });
  if (input.bmiProjectId && input.locationId != null) {
    params.set("loc", String(input.locationId));
    params.set("pid", input.bmiProjectId);
  }
  return `${host(input)}/waiver?${params.toString()}`;
}

export function dealLinks(input: DealLinkInput): DealLink[] {
  const links: DealLink[] = [];
  const c = input.contract;
  if (c) {
    const base = `${host(input)}/contract/${c.shortId}`;
    links.push({
      id: "contract",
      label: "Contract page",
      href: base,
      audience: "guest",
      hint: "Exactly what the guest sees — signing before they sign, their confirmation after",
    });
    links.push({
      id: "pdf",
      label: "Signed PDF",
      href: `${base}/pdf`,
      audience: "guest",
      hint: c.signedAt ? "The countersigned contract" : "Not signed yet — this will 404",
    });
    // Only worth offering while there is something left to collect.
    if (c.balanceCents > 0 && !c.balancePaidAt)
      links.push({
        id: "pay",
        label: "Pay balance",
        href: `${base}/pay`,
        audience: "guest",
        hint: "The self-hosted balance page — safe to send when a saved card has failed",
      });
  }
  links.push({
    id: "waiver",
    label: "Guest waiver",
    href: waiverHref(input),
    audience: "guest",
    hint: input.bmiProjectId
      ? "Signatures attach to this event"
      : "No BMI project yet — signatures will not attach to the event",
  });
  if (c)
    links.push({
      id: "history",
      label: "Contract history",
      href: `/admin/crm/deal/${encodeURIComponent(input.publicId)}?tab=history`,
      audience: "staff",
      hint: "Versions, field diffs, the audit log and every message the guest was sent",
    });
  return links;
}
