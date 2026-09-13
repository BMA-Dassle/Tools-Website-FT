/**
 * `crm_email_links` row → the wire shape the composer and the thread render.
 *
 * Its own module rather than a method on the data file so both the send path
 * and the read path map identically, and so a pure test can assert the mapping
 * without Neon.
 *
 * D6 (retention, brief default): an INBOUND row carries `preview` + `webLink`
 * only — never the guest's body — so `preview` here is Graph's `bodyPreview`
 * for inbound and the first lines of what WE composed for outbound.
 */

import { shortErrorClause, type EmailMatchedBy, type EmailMessageView } from "../contracts";
import type { EmailLink } from "../data/email-links-db";

const MATCHED_BY = new Set<string>(["from", "in-reply-to", "x-hp-lead", "composer"]);

export function matchedByOf(value: string | null): EmailMatchedBy {
  return value && MATCHED_BY.has(value) ? (value as EmailMatchedBy) : null;
}

export function toMessageView(link: EmailLink): EmailMessageView {
  return {
    id: link.id,
    mailbox: link.mailbox,
    graphMessageId: link.graphMessageId,
    leadId: link.leadId,
    repId: link.repId,
    direction: link.direction,
    subject: link.subject,
    preview: link.preview ?? (link.direction === "out" ? link.body : null),
    fromEmail: link.fromEmail,
    toEmails: link.toEmails,
    ccEmails: link.ccEmails,
    at: link.sentAt ?? link.createdAt,
    sendStatus: link.sendStatus,
    provider: link.provider,
    // The leading clause only: `send_error` can hold two thousand characters of
    // a Graph or SendGrid reply, and this field is rendered in the thread. The
    // full text stays on the row for a director (C2-9).
    sendError: shortErrorClause(link.sendError),
    matchedBy: matchedByOf(link.matchedBy),
    webLink: link.webLink,
  };
}
