/**
 * Which lead does this Graph message belong to?
 *
 * THE ORDER IS THE CONTRACT (brief C2): **from-address, then `In-Reply-To`,
 * then the `X-HP-Lead` header.** It reads backwards at first glance — the
 * header we control looks stronger than a guessable address — and it is
 * deliberate:
 *
 *   1. **from-address** — an inbound reply is almost always a person we
 *      already have a lead for, and the address is the key the rep would use.
 *      It also links a message that arrived by a route that never carried our
 *      header (forwarded, replied from the phone, sent from a different
 *      thread), which the header can never do.
 *   2. **In-Reply-To** — a reply to a message WE sent: `crm_email_links`
 *      already holds that Message-ID, so this pins the exact conversation even
 *      when the guest replies from a second address.
 *   3. **X-HP-Lead** — our own header on the outbound draft; it survives the
 *      move to Sent Items and reconciles the copy the Sent Items subscription
 *      shows us. It is last because a header is trivially spoofable from
 *      outside, and by the time we reach it the two evidence-based routes have
 *      already failed.
 *
 * Everything here except `matchMessage` is PURE — header and address plucking,
 * direction, the preview trim — so the ordering is pinned by a unit test with
 * no Graph and no Neon in sight.
 */

import type { EmailMatchedBy } from "../contracts";
import type { GraphMessage, GraphRecipient } from "./graph-client";
import { X_HP_LEAD_HEADER } from "./graph-client";

export const IN_REPLY_TO_HEADER = "In-Reply-To";

/** Lowercased, trimmed — the key `crm_contacts.email_key` is indexed on. */
export function emailKeyOf(email: string | null | undefined): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function addressOf(r: GraphRecipient | null | undefined): string | null {
  const a = r?.emailAddress?.address;
  return a ? a.trim() : null;
}

export function addressesOf(list: GraphRecipient[] | null | undefined): string[] {
  return (list ?? []).map(addressOf).filter((a): a is string => !!a);
}

/** Case-insensitive header lookup; Graph preserves the sender's casing. */
export function headerValue(msg: GraphMessage, name: string): string | null {
  const want = name.toLowerCase();
  for (const h of msg.internetMessageHeaders ?? []) {
    if (h?.name?.toLowerCase() === want) return h.value ?? null;
  }
  return null;
}

/**
 * `In-Reply-To` may carry several ids and stray whitespace; the first
 * angle-bracketed token is the one that names the message being replied to.
 */
export function firstMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /<[^<>\s]+>/.exec(raw);
  if (m) return m[0];
  const t = raw.trim();
  return t ? t : null;
}

/**
 * 'out' when the mailbox we are reading IS the sender (the Sent Items copy of
 * something the CRM or the rep sent), 'in' otherwise.
 */
export function directionOf(msg: GraphMessage, mailbox: string): "in" | "out" {
  const from = emailKeyOf(addressOf(msg.from ?? msg.sender));
  return from && from === emailKeyOf(mailbox) ? "out" : "in";
}

/** The guest's address on this message: the sender inbound, the recipient outbound. */
export function counterpartyOf(msg: GraphMessage, mailbox: string): string | null {
  if (directionOf(msg, mailbox) === "in") return addressOf(msg.from ?? msg.sender);
  const box = emailKeyOf(mailbox);
  return addressesOf(msg.toRecipients).find((a) => emailKeyOf(a) !== box) ?? null;
}

export const PREVIEW_MAX = 400;

export function previewOf(msg: GraphMessage): string | null {
  const p = (msg.bodyPreview ?? "").trim();
  return p ? p.slice(0, PREVIEW_MAX) : null;
}

/** `sentDateTime` then `receivedDateTime` then `createdDateTime`. */
export function occurredAtOf(msg: GraphMessage): string | null {
  return msg.sentDateTime ?? msg.receivedDateTime ?? msg.createdDateTime ?? null;
}

// ---------------------------------------------------------------------------
// The match itself
// ---------------------------------------------------------------------------

/** What the caller must be able to look up. Every one of these is B3's reader. */
export interface MatchDeps {
  /** Un-archived leads whose contact's email matches, newest first. */
  leadsByGuestEmail: (email: string) => Promise<MatchedLead[]>;
  /** The `crm_email_links` row whose Message-ID this reply names. */
  linkByInternetMessageId: (imid: string) => Promise<{ leadId: string | null } | null>;
  /** A lead by its public id ('L-1042') or numeric id. */
  leadByRef: (ref: string) => Promise<MatchedLead | null>;
}

export interface MatchedLead {
  id: string;
  publicId: string;
  contactId: string | null;
  assignedRepId: string | null;
  guestEmail: string | null;
  statusKindOpen: boolean;
  archived: boolean;
}

export interface MatchResult {
  lead: MatchedLead | null;
  matchedBy: EmailMatchedBy;
}

export const NO_MATCH: MatchResult = Object.freeze({ lead: null, matchedBy: null });

/**
 * Of several leads for the same guest, the one a rep means: live and open
 * first, then the newest (`leadsByGuestEmail` already returns newest first).
 */
export function preferredLead(leads: readonly MatchedLead[], address: string): MatchedLead | null {
  const key = emailKeyOf(address);
  const exact = leads.filter((l) => emailKeyOf(l.guestEmail) === key && !l.archived);
  return exact.find((l) => l.statusKindOpen) ?? exact[0] ?? null;
}

export async function matchMessage(
  msg: GraphMessage,
  mailbox: string,
  deps: MatchDeps,
): Promise<MatchResult> {
  // 1. from-address (inbound) / the recipient (outbound Sent Items copy)
  const counterparty = counterpartyOf(msg, mailbox);
  if (counterparty) {
    const lead = preferredLead(await deps.leadsByGuestEmail(counterparty), counterparty);
    if (lead) return { lead, matchedBy: "from" };
  }

  // 2. In-Reply-To → the outbound row we already stored
  const imid = firstMessageId(headerValue(msg, IN_REPLY_TO_HEADER));
  if (imid) {
    const link = await deps.linkByInternetMessageId(imid);
    if (link?.leadId) {
      const lead = await deps.leadByRef(link.leadId);
      if (lead) return { lead, matchedBy: "in-reply-to" };
    }
  }

  // 3. our own X-HP-Lead header
  const ref = headerValue(msg, X_HP_LEAD_HEADER)?.trim();
  if (ref) {
    const lead = await deps.leadByRef(ref);
    if (lead) return { lead, matchedBy: "x-hp-lead" };
  }

  return NO_MATCH;
}
